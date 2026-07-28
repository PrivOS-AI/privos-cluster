/**
 * Pure mapping: Docker inspect object + `privos.*` labels → API `Container`.
 *
 * Split from `docker-state.ts` so it has NO runtime dependency on the Docker
 * client (or, transitionally, the DB) and can be unit-tested with plain mock
 * inspect objects. `docker-state.ts` wires these into live docker queries.
 */
import type Docker from 'dockerode';
import { HEALTH_DEFAULTS } from './container-manager.js';
import type { Container, ContainerResources, ContainerState, ContainerVolume, HealthCheck, HealthPolicy } from '../types/index.js';

export const DEFAULT_RESOURCES: ContainerResources = { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 };
export const DEFAULT_HEALTH: HealthCheck = { status: 'unknown', failCount: 0, restartCount: 0, lastCheck: null };

/** Map a Docker `State.Status` to the coarse cluster `ContainerState`. */
export function mapState(status: string | undefined): ContainerState {
	switch (status) {
		case 'running':
		case 'restarting':
			return 'running';
		case 'created':
			return 'created';
		case 'exited':
		case 'dead':
		case 'removing':
		case 'paused':
			return 'stopped';
		default:
			return 'error';
	}
}

function labelOrNull(labels: Record<string, string>, key: string): string | null {
	const v = labels[key];
	return v && v.length > 0 ? v : null;
}

function parseResources(raw: string | undefined): ContainerResources {
	if (!raw) return { ...DEFAULT_RESOURCES };
	try {
		const p = JSON.parse(raw) as Partial<ContainerResources>;
		return {
			memoryMb: typeof p.memoryMb === 'number' ? p.memoryMb : DEFAULT_RESOURCES.memoryMb,
			cpus: typeof p.cpus === 'number' ? p.cpus : DEFAULT_RESOURCES.cpus,
			tmpSizeMb: typeof p.tmpSizeMb === 'number' ? p.tmpSizeMb : DEFAULT_RESOURCES.tmpSizeMb,
		};
	} catch {
		return { ...DEFAULT_RESOURCES };
	}
}

/**
 * Reconstruct the USER-supplied env from the `privos.env` label — NOT from
 * Config.Env, which also includes image-baked ENV (potential secrets) and the
 * injected PORT. Mirrors the DB, which only stored req.envVars.
 */
function parseEnv(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** Reconstruct logical volumes from the container's own mounts (no volumes table). */
function parseVolumes(info: Docker.ContainerInspectInfo, id: string): ContainerVolume[] {
	const prefix = `mcp-vol-${id.slice(0, 12)}-`;
	const mounts = (info.Mounts ?? []) as Array<{ Type?: string; Name?: string; Destination?: string }>;
	return mounts
		.filter((m) => m.Type === 'volume' && m.Name)
		.map((m) => ({
			name: m.Name!.startsWith(prefix) ? m.Name!.slice(prefix.length) : m.Name!,
			mountPath: m.Destination ?? '',
		}));
}

/** Reconstruct the self-restart health policy from `privos.health.*` labels. */
function parseHealthPolicy(labels: Record<string, string>): HealthPolicy {
	const maxFailsRaw = parseInt(labels['privos.health.max-fails'] ?? '', 10);
	return {
		path: labels['privos.health.path'] || HEALTH_DEFAULTS.path,
		maxFails: Number.isFinite(maxFailsRaw) && maxFailsRaw > 0 ? maxFailsRaw : HEALTH_DEFAULTS.maxFails,
		restart: labels['privos.health.restart'] !== undefined
			? labels['privos.health.restart'] !== 'false'
			: HEALTH_DEFAULTS.restart,
	};
}

function hostPortFor(info: Docker.ContainerInspectInfo, port: number): number | null {
	const bindings = info.NetworkSettings?.Ports?.[`${port}/tcp`];
	if (bindings && bindings.length > 0 && bindings[0].HostPort) {
		return parseInt(bindings[0].HostPort, 10);
	}
	return null;
}

function networkIpFor(info: Docker.ContainerInspectInfo): string | null {
	const networks = info.NetworkSettings?.Networks ?? {};
	const preferred = Object.entries(networks).find(([name]) => name.startsWith('privos-ws-'));
	return preferred?.[1]?.IPAddress || Object.values(networks)[0]?.IPAddress || null;
}

function toEpoch(value: string | undefined): number | null {
	if (!value) return null;
	const t = new Date(value).getTime();
	// Docker uses a zero-ish timestamp for "never" (e.g. FinishedAt on a running container).
	return Number.isFinite(t) && t > 0 ? t : null;
}

/**
 * Resolve transient duplicate identities to a single "active" container.
 *
 * During a rolling redeploy the old and new Docker containers briefly share the
 * same `privos.id` (labels are immutable — we can't atomically swap). To keep the
 * label model's single-identity invariant in the API view, pick ONE container per
 * id deterministically: prefer a `running` one, then the newest by Docker's real
 * creation time (the new container). This makes GET /apps / getById / findByHost
 * stable throughout the swap without mutating labels.
 */
export function pickActivePerId(items: Array<{ container: Container; dockerCreatedMs: number }>): Container[] {
	const best = new Map<string, { container: Container; dockerCreatedMs: number }>();
	for (const item of items) {
		const cur = best.get(item.container.id);
		if (!cur || isMoreActive(item, cur)) best.set(item.container.id, item);
	}
	return [...best.values()].map((v) => v.container);
}

function isMoreActive(a: { container: Container; dockerCreatedMs: number }, b: { container: Container; dockerCreatedMs: number }): boolean {
	const aRunning = a.container.state === 'running';
	const bRunning = b.container.state === 'running';
	if (aRunning !== bRunning) return aRunning; // a running container always wins
	return a.dockerCreatedMs > b.dockerCreatedMs; // otherwise the newer one
}

/**
 * PURE mapper: Docker inspect object + labels → API `Container`.
 * `health` overlays the ephemeral in-memory counters (default = unknown/0/0/null).
 */
export function mapInspectToContainer(info: Docker.ContainerInspectInfo, health: HealthCheck = DEFAULT_HEALTH): Container {
	const labels = (info.Config?.Labels ?? {}) as Record<string, string>;
	const id = labels['privos.id'] || info.Id;
	const port = parseInt(labels['privos.port'] ?? '0', 10) || 0;
	const state = mapState(info.State?.Status);
	const hostPort = hostPortFor(info, port);
	const networkIp = networkIpFor(info);
	const internalUrl = state === 'running'
		? networkIp
			? `http://${networkIp}:${port}`
			: hostPort
				? `http://localhost:${hostPort}`
				: ''
		: '';
	const createdAtRaw = labels['privos.created-at'];
	const createdAtLabel = createdAtRaw && /^\d+$/.test(createdAtRaw)
		? Number(createdAtRaw)
		: Date.parse(createdAtRaw ?? '');

	return {
		id,
		appId: labelOrNull(labels, 'privos.app-id'),
		workspaceId: labelOrNull(labels, 'privos.workspace'),
		listingId: labelOrNull(labels, 'privos.listing'),
		versionDigest: labelOrNull(labels, 'privos.version.digest'),
		dockerContainerId: info.Id,
		dockerContainerName: (info.Name ?? '').replace(/^\//, ''),
		image: labels['privos.image'] || (info.Config?.Image ?? '').split(':')[0],
		tag: labels['privos.tag'] || (info.Config?.Image ?? '').split(':')[1] || 'latest',
		state,
		internalUrl,
		port,
		hostPort,
		resources: parseResources(labels['privos.resources']),
		envVars: parseEnv(labels['privos.env']),
		healthCheck: health,
		createdAt: Number.isFinite(createdAtLabel) && createdAtLabel > 0 ? createdAtLabel : (toEpoch(info.Created) ?? Date.now()),
		startedAt: toEpoch(info.State?.StartedAt),
		stoppedAt: state === 'running' ? null : toEpoch(info.State?.FinishedAt),
		volumes: parseVolumes(info, id),
		subdomain: labelOrNull(labels, 'privos.subdomain'),
		domain: labelOrNull(labels, 'privos.domain'),
		healthPolicy: parseHealthPolicy(labels),
	};
}
