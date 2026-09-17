import type { MasterRepositories } from './repositories.js';
import type { ContainerResources } from '../types/index.js';
import type { MasterApp } from './types.js';

export class QuotaError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

/** A PROVISIONING row with no container yet and no reaper watching it must not
 * hold a quota reservation forever if the deploy attempt never lands (agent
 * crash, node lost). Past this age it drops out of the installed set. The
 * Portal admin apps listing mirrors this value when explaining a quota
 * decision to an operator. */
export const STALLED_PROVISIONING_TIMEOUT_MS = 30 * 60 * 1000;

/** The single definition of "installed" for quota purposes (app count AND
 * memory/cpu): reserved capacity the workspace is billed for. An app counts
 * iff it is RUNNING or STOPPED (a stopped app still holds its reservation),
 * pre-activation QUARANTINED (state QUARANTINED with no `quarantinedAt` —
 * activation flow has containers up but hasn't flipped the app to RUNNING
 * yet), or a PROVISIONING row younger than `STALLED_PROVISIONING_TIMEOUT_MS`.
 * Excluded: revoke-QUARANTINED (`quarantinedAt` set — grace-period teardown,
 * no longer billed), REMOVED/REMOVING, and a stale PROVISIONING row (its
 * attempt never landed a container, so nothing to reserve for). */
export function isInstalledForQuota(
	app: Pick<MasterApp, 'state' | 'quarantinedAt' | 'createdAt'>,
	now: Date,
): boolean {
	if (app.state === 'RUNNING' || app.state === 'STOPPED') return true;
	if (app.state === 'QUARANTINED') return !app.quarantinedAt;
	if (app.state === 'PROVISIONING') {
		return now.getTime() - app.createdAt.getTime() < STALLED_PROVISIONING_TIMEOUT_MS;
	}
	return false;
}

/** States a candidate app must be in to even be considered by `isInstalledForQuota` —
 * narrows the Mongo query so REMOVED/REMOVING rows (the overwhelming majority
 * over an app's lifetime) never cross the wire. */
const INSTALLED_CANDIDATE_STATES = ['RUNNING', 'STOPPED', 'QUARANTINED', 'PROVISIONING'];

export class QuotaService {
	constructor(private readonly repositories: MasterRepositories) {}

	async assertDeployAllowed(
		workspaceId: string,
		resources: ContainerResources,
		replicaCount: number,
	): Promise<void> {
		const now = new Date();
		const [workspace, candidates] = await Promise.all([
			this.repositories.workspaces.findOne({ workspaceId, status: 'ACTIVE' }),
			this.repositories.apps.find({ workspaceId, state: { $in: INSTALLED_CANDIDATE_STATES } }).toArray(),
		]);
		if (!workspace) throw new QuotaError('WORKSPACE_NOT_FOUND', 'workspace not found');
		const installed = candidates.filter((app) => isInstalledForQuota(app, now));
		if (installed.length >= workspace.quota.maxApps) {
			throw new QuotaError('APP_QUOTA_EXCEEDED', 'workspace app count quota exceeded');
		}
		const used = installed.reduce(
			(total, app) => ({
				memoryMb: total.memoryMb + app.resources.memoryMb * app.replicas.length,
				cpus: total.cpus + app.resources.cpus * app.replicas.length,
			}),
			{ memoryMb: 0, cpus: 0 },
		);
		if (used.memoryMb + resources.memoryMb * replicaCount > workspace.quota.maxMemoryMb) {
			throw new QuotaError('MEMORY_QUOTA_EXCEEDED', 'workspace reserved memory quota exceeded');
		}
		if (used.cpus + resources.cpus * replicaCount > workspace.quota.maxCpus) {
			throw new QuotaError('CPU_QUOTA_EXCEEDED', 'workspace reserved CPU quota exceeded');
		}
	}

	/**
	 * A resize is not a new app — the app is already in the installed set, so
	 * `maxApps` never applies here. Only the DELTA between the new and current
	 * per-replica resources is checked against the workspace's remaining
	 * memory/cpu headroom: `used` already includes the app's CURRENT
	 * reservation (it is RUNNING), so `used + delta` is exactly what the
	 * workspace would hold after the resize.
	 */
	async assertResizeAllowed(
		workspaceId: string,
		app: Pick<MasterApp, 'resources' | 'replicas'>,
		newResources: ContainerResources,
	): Promise<void> {
		const now = new Date();
		const [workspace, candidates] = await Promise.all([
			this.repositories.workspaces.findOne({ workspaceId, status: 'ACTIVE' }),
			this.repositories.apps.find({ workspaceId, state: { $in: INSTALLED_CANDIDATE_STATES } }).toArray(),
		]);
		if (!workspace) throw new QuotaError('WORKSPACE_NOT_FOUND', 'workspace not found');
		const installed = candidates.filter((candidate) => isInstalledForQuota(candidate, now));
		const used = installed.reduce(
			(total, candidate) => ({
				memoryMb: total.memoryMb + candidate.resources.memoryMb * candidate.replicas.length,
				cpus: total.cpus + candidate.resources.cpus * candidate.replicas.length,
			}),
			{ memoryMb: 0, cpus: 0 },
		);
		const replicaCount = app.replicas.length;
		const deltaMemoryMb = (newResources.memoryMb - app.resources.memoryMb) * replicaCount;
		const deltaCpus = (newResources.cpus - app.resources.cpus) * replicaCount;
		if (used.memoryMb + deltaMemoryMb > workspace.quota.maxMemoryMb) {
			throw new QuotaError('MEMORY_QUOTA_EXCEEDED', 'workspace reserved memory quota exceeded');
		}
		if (used.cpus + deltaCpus > workspace.quota.maxCpus) {
			throw new QuotaError('CPU_QUOTA_EXCEEDED', 'workspace reserved CPU quota exceeded');
		}
	}

	async assertAdditionalReplicaAllowed(workspaceId: string, resources: ContainerResources): Promise<void> {
		const now = new Date();
		const [workspace, candidates] = await Promise.all([
			this.repositories.workspaces.findOne({ workspaceId, status: 'ACTIVE' }),
			this.repositories.apps.find({ workspaceId, state: { $in: INSTALLED_CANDIDATE_STATES } }).toArray(),
		]);
		if (!workspace) throw new QuotaError('WORKSPACE_NOT_FOUND', 'workspace not found');
		const installed = candidates.filter((app) => isInstalledForQuota(app, now));
		const used = installed.reduce(
			(total, app) => ({
				memoryMb: total.memoryMb + app.resources.memoryMb * app.replicas.length,
				cpus: total.cpus + app.resources.cpus * app.replicas.length,
			}),
			{ memoryMb: 0, cpus: 0 },
		);
		if (used.memoryMb + resources.memoryMb > workspace.quota.maxMemoryMb) {
			throw new QuotaError('MEMORY_QUOTA_EXCEEDED', 'workspace reserved memory quota exceeded');
		}
		if (used.cpus + resources.cpus > workspace.quota.maxCpus) {
			throw new QuotaError('CPU_QUOTA_EXCEEDED', 'workspace reserved CPU quota exceeded');
		}
	}
}
