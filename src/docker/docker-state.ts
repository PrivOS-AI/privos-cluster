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
import { mapInspectToContainer } from './docker-state-mapper.js';
import type { Container, HealthCheck } from '../types/index.js';

const MANAGED_LABEL = 'privos.managed=true';

/** Optional provider of ephemeral health per container id (in-memory monitor). */
export type HealthProvider = (id: string) => HealthCheck | undefined;

async function inspectManaged(filters: Record<string, string[]>, health?: HealthProvider): Promise<Container[]> {
	const list = await containerManager.listContainers(filters, true);
	const out: Container[] = [];
	for (const item of list) {
		try {
			const info = await containerManager.inspectContainer(item.Id);
			const mapped = mapInspectToContainer(info as unknown as Docker.ContainerInspectInfo);
			out.push(health ? { ...mapped, healthCheck: health(mapped.id) ?? mapped.healthCheck } : mapped);
		} catch {
			// container vanished between list and inspect — skip
		}
	}
	return out;
}

export async function listManaged(health?: HealthProvider): Promise<Container[]> {
	const all = await inspectManaged({ label: [MANAGED_LABEL] }, health);
	return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getById(id: string, health?: HealthProvider): Promise<Container | null> {
	const found = await inspectManaged({ label: [MANAGED_LABEL, `privos.id=${id}`] }, health);
	return found[0] ?? null;
}

export async function getByAppId(appId: string, health?: HealthProvider): Promise<Container | null> {
	const found = await inspectManaged({ label: [MANAGED_LABEL, `privos.app-id=${appId}`] }, health);
	return found[0] ?? null;
}

export async function getByDockerContainerId(dockerId: string, health?: HealthProvider): Promise<Container | null> {
	try {
		const info = await containerManager.inspectContainer(dockerId);
		const labels = (info as any).Config?.Labels ?? {};
		if (labels['privos.managed'] !== 'true') return null;
		const mapped = mapInspectToContainer(info as unknown as Docker.ContainerInspectInfo);
		return health ? { ...mapped, healthCheck: health(mapped.id) ?? mapped.healthCheck } : mapped;
	} catch {
		return null;
	}
}

/** Per-host uniqueness (subdomain + domain) purely from labels. */
export async function findByHost(subdomain: string, domain: string | null): Promise<Container | null> {
	const filters: Record<string, string[]> = { label: [MANAGED_LABEL, `privos.subdomain=${subdomain}`] };
	if (domain) filters.label.push(`privos.domain=${domain}`);
	const found = await inspectManaged(filters);
	// When domain is null, exclude containers that DO carry a domain.
	return found.find((c) => (c.domain ?? null) === (domain ?? null)) ?? null;
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
