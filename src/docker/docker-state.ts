/**
 * Docker-as-database: query the API `Container` view purely from Docker
 * (`docker ps` + `docker inspect` + the `privos.*` labels written at create).
 * No SQLite. Replaces the read side of `containers-repo`.
 *
 * The pure inspect→Container mapping lives in `docker-state-mapper.ts` (unit
 * tested there); this module only wires it into live docker queries.
 */
import type Docker from 'dockerode';
import { containerManager } from './index.js';
import { mapListEntryToContainer, pickActivePerId } from './docker-state-mapper.js';
import type { Container, HealthCheck } from '../types/index.js';

const MANAGED_LABEL = 'privos.managed=true';

/** Optional provider of ephemeral health per container id (in-memory monitor). */
export type HealthProvider = (id: string) => HealthCheck | undefined;

/** Optional provider of the ephemeral last-OOM-kill epoch ms per container id
 * (in-memory health monitor — `docker ps` carries no `State.OOMKilled`). */
export type OomProvider = (id: string) => number | null | undefined;

/**
 * Inspect every matching managed container and collapse transient duplicate ids
 * (rolling-redeploy overlap) to one active container per id — prefer running,
 * then newest by Docker's real creation time (see pickActivePerId).
 */
async function inspectManaged(
	filters: Record<string, string[]>,
	health?: HealthProvider,
	oom?: OomProvider,
): Promise<Container[]> {
	// One `containers/json` (docker ps) call — the list entry already carries labels,
	// state, ports, networks and mounts, so there is no per-container inspect here.
	const list = (await containerManager.listContainers(filters, true)) as Docker.ContainerInfo[];
	const items = list.map((entry) => {
		const mapped = mapListEntryToContainer(entry, undefined, oom ? oom(entry.Labels?.['privos.id'] ?? entry.Id) ?? null : null);
		const container = health ? { ...mapped, healthCheck: health(mapped.id) ?? mapped.healthCheck } : mapped;
		return { container, dockerCreatedMs: (entry.Created ?? 0) * 1000 };
	});
	return pickActivePerId(items);
}

export async function listManaged(health?: HealthProvider, workspaceId?: string, oom?: OomProvider): Promise<Container[]> {
	const labels = [MANAGED_LABEL];
	if (workspaceId) labels.push(`privos.workspace=${workspaceId}`);
	const all = await inspectManaged({ label: labels }, health, oom);
	return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getById(
	id: string,
	health?: HealthProvider,
	workspaceId?: string,
	oom?: OomProvider,
): Promise<Container | null> {
	const labels = [MANAGED_LABEL, `privos.id=${id}`];
	if (workspaceId) labels.push(`privos.workspace=${workspaceId}`);
	const found = await inspectManaged({ label: labels }, health, oom);
	return found[0] ?? null;
}

/**
 * A schema-3 (v3) container must never be served by the legacy loopback
 * listener's `splitHost`/`findByHost` fallback — v3 public hosts are routed
 * exclusively through the new ingress/runtime listeners (`src/proxy/{ingress,
 * runtime}-listener.ts`), so an old v3 label can never come back to life here.
 */
export function isEligibleForLegacyHostFallback(c: Container): boolean {
	return c.mcpV3 !== true;
}

/** Per-host uniqueness (subdomain + domain) purely from labels. */
export async function findByHost(subdomain: string, domain: string | null): Promise<Container | null> {
	const filters: Record<string, string[]> = { label: [MANAGED_LABEL, `privos.subdomain=${subdomain}`] };
	if (domain) filters.label.push(`privos.domain=${domain}`);
	const found = await inspectManaged(filters);
	// When domain is null, exclude containers that DO carry a domain.
	return found.find((c) => (c.domain ?? null) === (domain ?? null) && isEligibleForLegacyHostFallback(c)) ?? null;
}

/**
 * Runtime-listener host resolution: host → appId (from the fleet host table)
 * → container, resolved by labels alone (never by the table's `containerId`
 * string), scoped to schema-3 so a stale table entry can never point at a
 * plain/v2 container of the same appId/workspace.
 */
export async function findByAppId(appId: string, workspaceId: string): Promise<Container | null> {
	const filters: Record<string, string[]> = {
		label: [MANAGED_LABEL, `privos.app-id=${appId}`, `privos.workspace=${workspaceId}`, 'privos.mcp.schema=3'],
	};
	const found = await inspectManaged(filters);
	return found[0] ?? null;
}

/** Sum of allocated resources across managed containers (budget check). */
export async function sumAllocatedResources(): Promise<{ memoryMb: number; cpus: number; containers: number }> {
	const all = await listManaged();
	return all.reduce(
		(acc, c) => ({
			memoryMb: acc.memoryMb + c.resources.memoryMb,
			cpus: acc.cpus + c.resources.cpus,
			containers: acc.containers + 1,
		}),
		{ memoryMb: 0, cpus: 0, containers: 0 },
	);
}
