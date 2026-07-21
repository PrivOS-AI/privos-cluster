/**
 * In-memory health monitor. No database — Docker labels are the source of
 * truth for policy (probe path / max consecutive fails / whether to auto-
 * restart); the ephemeral fail/restart counters live only in this process's
 * memory and reset on agent restart (acceptable — Docker itself is still the
 * durable record of container state).
 */
import pino from 'pino';
import { config } from '../config.js';
import { containerManager } from '../docker/index.js';
import { listManaged, type HealthProvider } from '../docker/docker-state.js';
import { HEALTH_DEFAULTS } from '../docker/container-manager.js';
import type { Container, HealthCheck, HealthPolicy } from '../types/index.js';

const logger = pino({ level: config.LOG_LEVEL }).child({ component: 'health-monitor' });

const PROBE_TIMEOUT_MS = 5_000;

const FALLBACK_POLICY: HealthPolicy = {
	path: HEALTH_DEFAULTS.path,
	maxFails: HEALTH_DEFAULTS.maxFails,
	restart: HEALTH_DEFAULTS.restart,
};

// containerId (privos.id) -> ephemeral health counters
const healthState = new Map<string, HealthCheck>();

let timer: NodeJS.Timeout | null = null;
let busy = false;

/** Overlay provider consumed by docker-state.ts / lifecycle-service.ts. */
export const getHealth: HealthProvider = (id) => healthState.get(id);

// ---------------------------------------------------------------------------
// Pure decision logic — unit-testable without network or Docker.
// ---------------------------------------------------------------------------

/**
 * Given the current ephemeral health state, the outcome of the latest probe,
 * and the container's restart policy, compute the next health state.
 *
 * On threshold breach with restart enabled, this optimistically returns the
 * post-restart state (status 'unknown', failCount reset, restartCount+1) —
 * the caller is responsible for actually invoking the restart and reverting
 * on failure via `revertFailedRestart`.
 */
export function computeHealthTransition(
	current: HealthCheck,
	healthy: boolean,
	policy: Pick<HealthPolicy, 'maxFails' | 'restart'>,
	now: number,
): { next: HealthCheck; shouldRestart: boolean } {
	if (healthy) {
		return {
			next: { status: 'healthy', failCount: 0, restartCount: current.restartCount, lastCheck: now },
			shouldRestart: false,
		};
	}

	const failCount = current.failCount + 1;
	if (failCount >= policy.maxFails && policy.restart) {
		return {
			next: { status: 'unknown', failCount: 0, restartCount: current.restartCount + 1, lastCheck: now },
			shouldRestart: true,
		};
	}

	return {
		next: { status: 'unhealthy', failCount, restartCount: current.restartCount, lastCheck: now },
		shouldRestart: false,
	};
}

/** Revert an optimistic restart transition when the actual Docker restart call failed. */
export function revertFailedRestart(afterRestart: HealthCheck, policy: Pick<HealthPolicy, 'maxFails'>, now: number): HealthCheck {
	return { status: 'unhealthy', failCount: policy.maxFails, restartCount: afterRestart.restartCount, lastCheck: now };
}

// ---------------------------------------------------------------------------
// Impure wiring — HTTP probes + Docker restart calls.
// ---------------------------------------------------------------------------

async function probe(internalUrl: string, healthPath: string): Promise<boolean> {
	try {
		const res = await fetch(`${internalUrl}${healthPath}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		if (res.ok) return true;
		if (res.status !== 404) return false;
	} catch {
		return false;
	}

	// 404 on the configured path — fall back to the MCP manifest endpoint,
	// mirroring lifecycle-service's waitForHealthy behavior.
	try {
		const fallback = await fetch(`${internalUrl}/.well-known/mcp/manifest.json`, {
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		return fallback.ok;
	} catch {
		return false;
	}
}

async function checkOne(c: Container): Promise<void> {
	const policy = c.healthPolicy ?? FALLBACK_POLICY;
	const current = healthState.get(c.id) ?? c.healthCheck;

	const healthy = await probe(c.internalUrl, policy.path);
	const now = Date.now();
	const { next, shouldRestart } = computeHealthTransition(current, healthy, policy, now);
	healthState.set(c.id, next);

	if (!shouldRestart) return;

	logger.info({ containerId: c.id, restartCount: next.restartCount }, 'auto-restarting unhealthy container');
	try {
		await containerManager.restartContainer(c.dockerContainerId);
	} catch (err: any) {
		logger.error({ containerId: c.id, err: err.message }, 'auto-restart failed');
		healthState.set(c.id, revertFailedRestart(next, policy, Date.now()));
	}
}

async function checkAll(): Promise<void> {
	const containers = await listManaged(getHealth);
	// Prune ephemeral health entries for containers that no longer exist, so the
	// in-memory map can't grow unbounded across deploy/delete cycles.
	const liveIds = new Set(containers.map((c) => c.id));
	for (const id of healthState.keys()) {
		if (!liveIds.has(id)) healthState.delete(id);
	}
	const running = containers.filter((c) => c.state === 'running');
	await Promise.allSettled(running.map((c) => checkOne(c)));
}

async function tick(): Promise<void> {
	if (busy) return;
	busy = true;
	try {
		await checkAll();
	} catch (err: any) {
		logger.error({ err: err.message }, 'health monitor tick failed');
	} finally {
		busy = false;
	}
}

export function startHealthMonitor(): void {
	if (timer) return;
	timer = setInterval(() => void tick(), config.HEALTH_CHECK_INTERVAL_MS);
	logger.info({ intervalMs: config.HEALTH_CHECK_INTERVAL_MS }, 'health monitor started');
}

export function stopHealthMonitor(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	logger.info('health monitor stopped');
}
