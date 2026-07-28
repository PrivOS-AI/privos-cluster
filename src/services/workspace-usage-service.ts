import { containerManager } from '../docker/index.js';
import * as dockerState from '../docker/docker-state.js';
import type { Container, ContainerResources } from '../types/index.js';

export interface WorkspaceAppUsage {
	appId: string;
	state: Container['state'];
	resources: ContainerResources;
	volumeBytes: number;
}

export interface WorkspaceUsageSnapshot {
	workspaceId: string;
	generatedAt: string;
	apps: WorkspaceAppUsage[];
	totals: {
		runningApps: number;
		reservedMemoryMb: number;
		reservedCpus: number;
		volumeBytes: number;
	};
}

export function summarizeWorkspaceUsage(
	workspaceId: string,
	containers: Container[],
	volumeSizes: ReadonlyMap<string, number>,
	now = new Date(),
): WorkspaceUsageSnapshot {
	const apps = containers.map((container) => ({
		appId: container.id,
		state: container.state,
		resources: container.resources,
		volumeBytes: container.volumes.reduce(
			(total, volume) => total + (volumeSizes.get(volume.name) ?? 0),
			0,
		),
	}));
	return {
		workspaceId,
		generatedAt: now.toISOString(),
		apps,
		totals: {
			runningApps: apps.filter((app) => app.state === 'running').length,
			reservedMemoryMb: apps
				.filter((app) => app.state === 'running')
				.reduce((total, app) => total + app.resources.memoryMb, 0),
			reservedCpus: apps
				.filter((app) => app.state === 'running')
				.reduce((total, app) => total + app.resources.cpus, 0),
			volumeBytes: apps.reduce((total, app) => total + app.volumeBytes, 0),
		},
	};
}

export async function getWorkspaceUsage(workspaceId: string): Promise<WorkspaceUsageSnapshot> {
	const containers = await dockerState.listManaged(undefined, workspaceId);
	const volumeNames = new Set(containers.flatMap((container) => container.volumes.map((volume) => volume.name)));
	const sizes = new Map<string, number>();
	await Promise.all([...volumeNames].map(async (name) => {
		sizes.set(name, await containerManager.getVolumeSizeBytes(name));
	}));
	return summarizeWorkspaceUsage(workspaceId, containers, sizes);
}
