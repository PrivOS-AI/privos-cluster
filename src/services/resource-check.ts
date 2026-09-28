/**
 * Cluster-level resource accounting.
 *
 * "Host" = whatever the Docker daemon reports via /info.
 * "Allocated" = sum of memory + cpu limits across all Docker-managed containers
 *               (privos.managed=true label), derived live from Docker — no DB.
 * "Budget"    = admin-configured quota (CLUSTER_MAX_*), or else the app-node
 *               rule: CPU (cores − reserved) × overcommit, RAM total × fraction.
 * "Available" = budget − allocated.
 */
import * as dockerState from '../docker/docker-state.js';
import { docker } from '../docker/index.js';
import { getBudgetRule, getMaxCpus, getMaxMemoryMb } from './settings-service.js';
import type { ClusterResources } from '../types/index.js';

/**
 * The allocation budget for app containers on this host. Pure so the rule is
 * testable. At least one core always stays allocatable, so a 2-core host still
 * gets a budget (1 x overcommit) instead of zero.
 */
export function resolveResourceBudget(input: {
	hostCpus: number;
	hostMemMb: number;
	maxCpus: number | null;
	maxMemoryMb: number | null;
	cpuReserved: number;
	cpuOvercommit: number;
	memoryFraction: number;
}): ClusterResources['budget'] {
	const ruleCpus = Math.max(1, input.hostCpus - input.cpuReserved) * input.cpuOvercommit;
	const ruleMemoryMb = Math.floor(input.hostMemMb * input.memoryFraction);
	return {
		cpus: input.maxCpus ?? Math.round(ruleCpus * 100) / 100,
		memoryMb: input.maxMemoryMb ?? ruleMemoryMb,
		cpuSource: input.maxCpus === null ? 'rule' : 'configured',
		memorySource: input.maxMemoryMb === null ? 'rule' : 'configured',
	};
}

export async function getClusterResources(): Promise<ClusterResources> {
	const info = await docker.info();

	const hostMemMb = Math.floor((info.MemTotal ?? 0) / (1024 * 1024));
	const hostCpus = info.NCPU ?? 0;

	const allocated = await dockerState.sumAllocatedResources();

	const budget = resolveResourceBudget({
		hostCpus,
		hostMemMb,
		maxCpus: getMaxCpus(),
		maxMemoryMb: getMaxMemoryMb(),
		...getBudgetRule(),
	});
	const capMem = budget.memoryMb;
	const capCpu = budget.cpus;

	return {
		host: { totalMemoryMb: hostMemMb, cpuCount: hostCpus },
		allocated: {
			memoryMb: allocated.memoryMb,
			cpus: Math.round(allocated.cpus * 100) / 100,
			containers: allocated.containers,
		},
		available: {
			memoryMb: Math.max(0, capMem - allocated.memoryMb),
			cpus: Math.max(0, Math.round((capCpu - allocated.cpus) * 100) / 100),
		},
		budget,
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
