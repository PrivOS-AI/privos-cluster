/**
 * Pure mapping: Docker inspect object + `privos.*` labels → API `Container`.
 *
 * Split from `docker-state.ts` so it has NO runtime dependency on the Docker
 * client (or, transitionally, the DB) and can be unit-tested with plain mock
 * inspect objects. `docker-state.ts` wires these into live docker queries.
 */
import type Docker from 'dockerode';
import type { Container, ContainerResources, ContainerState, ContainerVolume, HealthCheck } from '../types/index.js';

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

function hostPortFor(info: Docker.ContainerInspectInfo, port: number): number | null {
	const bindings = info.NetworkSettings?.Ports?.[`${port}/tcp`];
	if (bindings && bindings.length > 0 && bindings[0].HostPort) {
		return parseInt(bindings[0].HostPort, 10);
	}
	return null;
}

function toEpoch(value: string | undefined): number | null {
	if (!value) return null;
	const t = new Date(value).getTime();
	// Docker uses a zero-ish timestamp for "never" (e.g. FinishedAt on a running container).
	return Number.isFinite(t) && t > 0 ? t : null;
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
	const internalUrl = state === 'running' && hostPort ? `http://localhost:${hostPort}` : '';
	const createdAtLabel = parseInt(labels['privos.created-at'] ?? '', 10);

	return {
		id,
		appId: labelOrNull(labels, 'privos.app-id'),
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
	};
}
