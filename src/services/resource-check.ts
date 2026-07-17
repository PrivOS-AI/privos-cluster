/**
 * Cluster-level resource accounting.
 *
 * "Host" = whatever the Docker daemon reports via /info.
 * "Allocated" = sum of memory + cpu limits across containers tracked in our DB
 *               that are in a running/created state (not stopped).
 * "Available" = max(host or admin-configured quota) − allocated.
 *
 * Admins can override host capacity via the
 *   quota.max_memory_mb_total / quota.max_cpus_total
 * settings — useful when the cluster shares a host with other workloads.
 */
import * as containersRepo from '../db/containers-repo.js';
import { docker } from '../docker/index.js';
import { getMaxCpus, getMaxMemoryMb } from './settings-service.js';
import type { ClusterResources } from '../types/index.js';

export async function getClusterResources(): Promise<ClusterResources> {
	const info = await docker.info();

	const hostMemMb = Math.floor((info.MemTotal ?? 0) / (1024 * 1024));
	const hostCpus = info.NCPU ?? 0;

	// Sum allocations from containers we track (excluding 'error' rows — those
	// have no live container reserving anything).
	const tracked = containersRepo.findAll();
	let memMb = 0;
	let cpus = 0;
	let active = 0;
	for (const c of tracked) {
		if (c.state === 'error') continue;
		memMb += c.resources.memoryMb;
		cpus += c.resources.cpus;
		active++;
	}

	const capMem = getMaxMemoryMb() ?? hostMemMb;
	const capCpu = getMaxCpus() ?? hostCpus;

	return {
		host: { totalMemoryMb: hostMemMb, cpuCount: hostCpus },
		allocated: { memoryMb: memMb, cpus: Math.round(cpus * 100) / 100, containers: active },
		available: {
			memoryMb: Math.max(0, capMem - memMb),
			cpus: Math.max(0, Math.round((capCpu - cpus) * 100) / 100),
		},
	};
}

export interface ResourceCheckResult {
	ok: boolean;
	reason?: 'memory' | 'cpu';
	requested: { memoryMb: number; cpus: number };
	available: { memoryMb: number; cpus: number };
}

/**
 * Pre-flight check: would this request still fit within the available budget?
 * Useful before deploy to fail fast with a 409 instead of letting Docker OOM
 * the host or accept a container we can't actually run.
 */
export async function checkResourceRequest(req: {
	memoryMb: number;
	cpus: number;
}): Promise<ResourceCheckResult> {
	const cluster = await getClusterResources();
	if (req.memoryMb > cluster.available.memoryMb) {
		return {
			ok: false,
			reason: 'memory',
			requested: { memoryMb: req.memoryMb, cpus: req.cpus },
			available: cluster.available,
		};
	}
	if (req.cpus > cluster.available.cpus) {
		return {
			ok: false,
			reason: 'cpu',
			requested: { memoryMb: req.memoryMb, cpus: req.cpus },
			available: cluster.available,
		};
	}
	return {
		ok: true,
		requested: { memoryMb: req.memoryMb, cpus: req.cpus },
		available: cluster.available,
	};
}
