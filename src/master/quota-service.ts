import type { MasterRepositories } from './repositories.js';
import type { ContainerResources } from '../types/index.js';

export class QuotaError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

export class QuotaService {
	constructor(private readonly repositories: MasterRepositories) {}

	async assertDeployAllowed(
		workspaceId: string,
		resources: ContainerResources,
		replicaCount: number,
	): Promise<void> {
		const [workspace, apps] = await Promise.all([
			this.repositories.workspaces.findOne({ workspaceId, status: 'ACTIVE' }),
			this.repositories.apps.find({ workspaceId, state: { $ne: 'REMOVED' } }).toArray(),
		]);
		if (!workspace) throw new QuotaError('WORKSPACE_NOT_FOUND', 'workspace not found');
		if (apps.length >= workspace.quota.maxApps) {
			throw new QuotaError('APP_QUOTA_EXCEEDED', 'workspace app count quota exceeded');
		}
		const running = apps.filter((app) => app.state === 'RUNNING');
		const used = running.reduce(
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
}
