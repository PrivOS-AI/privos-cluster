import fs from 'node:fs/promises';

import { getAppNetworkName } from '../services/settings-service.js';
import type { DesiredStateStore } from './desired-state.js';
import { WORKSPACE_APP_NETWORK_PATTERN } from './network-manager.js';

export const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const RECOVERY_CONCURRENCY = 4;

export interface RecoveryDeps {
	store: DesiredStateStore;
	readBootId: () => Promise<string>;
	listManaged: () => Promise<Array<{ Id: string; State?: string }>>;
	inspect: (dockerId: string) => Promise<any>;
	start: (dockerId: string) => Promise<void>;
	repairNetwork: (
		dockerId: string,
		networkName: string,
		workspaceId: string,
		endpointNetworkId: string | undefined,
	) => Promise<boolean>;
	isBound: (replicaId: string) => boolean;
	log: {
		info: (obj: object, msg: string) => void;
		warn: (obj: object, msg: string) => void;
		error: (obj: object, msg: string) => void;
	};
}

export interface RecoverySummary {
	mode: 'seeded' | 'recovered' | 'unavailable';
	seeded: number;
	started: number;
	skipped: Record<string, number>;
	failed: number;
}

export const readHostBootId = async (): Promise<string> => (await fs.readFile(BOOT_ID_PATH, 'utf8')).trim();

/**
 * Start-up step of the fleet agent. Acts only on the first agent start after a host boot
 * (recorded boot id differs from the current one); on any other start it just records
 * running containers that have no entry yet, so a deploy or crash restart never revives
 * a container that died on its own. Never throws.
 */
export async function recoverDesiredState(deps: RecoveryDeps): Promise<RecoverySummary> {
	const summary: RecoverySummary = { mode: 'unavailable', seeded: 0, started: 0, skipped: {}, failed: 0 };
	const skip = (reason: string): void => { summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1; };
	try {
		if (!deps.store.isEnabled()) return summary;
		const currentBoot = await deps.readBootId();
		const recorded = await deps.store.read();
		const managed = await deps.listManaged();
		const running = managed.filter((container) => container.State === 'running').map((container) => container.Id);
		const newBoot = Boolean(recorded?.bootId) && recorded!.bootId !== currentBoot;

		if (newBoot) {
			const candidates = Object.entries(recorded!.containers)
				.filter(([, desired]) => desired === 'running')
				.map(([id]) => id);
			await runPool(candidates, RECOVERY_CONCURRENCY, async (id) => {
				try {
					const outcome = await recoverOne(deps, id);
					if (outcome === 'started') summary.started += 1;
					else skip(outcome);
				} catch (err) {
					summary.failed += 1;
					deps.log.error({ err, dockerId: id }, 'desired-state recovery failed for container');
				}
			});
		}
		summary.mode = newBoot ? 'recovered' : 'seeded';
		summary.seeded = running.filter((id) => recorded?.containers[id] === undefined).length;
		// Stamped last: a crash half-way leaves the old boot id, so the next start retries.
		await deps.store.seedAndStamp(running, currentBoot);
	} catch (err) {
		deps.log.error({ err }, 'desired-state recovery aborted');
	}
	deps.log.info({ ...summary }, 'desired-state recovery finished');
	return summary;
}

async function recoverOne(deps: RecoveryDeps, id: string): Promise<string> {
	// The record can change while the pool works (an operator stop, a remove): re-read it.
	if ((await deps.store.get(id)) !== 'running') return 'stoppedOnReread';
	let info: any;
	try {
		info = await deps.inspect(id);
	} catch (err: any) {
		if (err?.statusCode === 404) {
			await deps.store.remove(id);
			return 'gone';
		}
		throw err;
	}
	if (info.State?.Running) return 'alreadyRunning';
	if (info.State?.OOMKilled) {
		deps.log.warn({ dockerId: id }, 'container was OOM-killed; not restarted after boot');
		return 'oomKilled';
	}
	const labels = (info.Config?.Labels ?? {}) as Record<string, string>;
	const schema = labels['privos.mcp.schema'];
	if (schema === '2' || schema === '3') {
		const replicaId = labels['privos.mcp.replica'];
		if (!replicaId || !deps.isBound(replicaId)) {
			deps.log.warn({ dockerId: id, replicaId, signal: 'brokerUnbound' }, 'MCP broker is not bound; container not started');
			return 'brokerUnbound';
		}
	}
	const networkMode: string | undefined = info.HostConfig?.NetworkMode;
	if (networkMode && WORKSPACE_APP_NETWORK_PATTERN.test(networkMode)) {
		const workspaceId = labels['privos.workspace'];
		let expected: string | undefined;
		try {
			expected = workspaceId ? getAppNetworkName(workspaceId) : undefined;
		} catch {
			expected = undefined;
		}
		if (!workspaceId || networkMode !== expected) {
			deps.log.warn({ dockerId: id, networkMode, expected }, 'container network does not match its workspace; not started');
			return 'networkMismatch';
		}
		const endpointId: string | undefined = info.NetworkSettings?.Networks?.[networkMode]?.NetworkID;
		if (await deps.repairNetwork(id, networkMode, workspaceId, endpointId)) {
			deps.log.info({ dockerId: id, networkMode }, 'workspace network recreated or reattached');
		}
	}
	await deps.start(id);
	return 'started';
}

async function runPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	const queue = [...items];
	await Promise.all(
		Array.from({ length: Math.min(limit, queue.length) }, async () => {
			for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
		}),
	);
}

/** Wraps a sweep so it never runs while recovery is still starting containers that need their networks. */
export function afterRecovery<T>(recoveryDone: Promise<unknown>, sweep: () => Promise<T>): () => Promise<T> {
	return async () => {
		await recoveryDone;
		return sweep();
	};
}
