export interface ContainerVolume {
	name: string;
	mountPath: string;
	sizeMb?: number;
}

export interface ContainerRecord {
	id: string;
	appId: string | null;
	dockerContainerId: string;
	dockerContainerName: string;
	image: string;
	tag: string;
	state: 'created' | 'running' | 'stopped' | 'error';
	internalUrl: string;
	port: number;
	hostPort: number | null;
	resources: {
		memoryMb: number;
		cpus: number;
		tmpSizeMb: number;
	};
	envVars: Record<string, string>;
	healthCheck: {
		status: 'healthy' | 'unhealthy' | 'unknown';
		failCount: number;
		restartCount: number;
		lastCheck: number | null;
	};
	createdAt: number;
	startedAt: number | null;
	stoppedAt: number | null;
	volumes: ContainerVolume[];
	adopted?: boolean;
	subdomain?: string | null;
}

export interface StatusResponse {
	state: ContainerRecord['state'];
	cpuPercent: number;
	memoryUsageMb: number;
	memoryLimitMb: number;
	memoryPercent: number;
	uptime: number | null;
	restarts: number;
	healthStatus: ContainerRecord['healthCheck']['status'];
}

export interface ClusterResourcesResponse {
	host: { totalMemoryMb: number; cpuCount: number };
	allocated: { memoryMb: number; cpus: number; containers: number };
	available: { memoryMb: number; cpus: number };
}

export interface FileEntry {
	name: string;
	type: 'file' | 'directory' | 'link';
	size: number;
	modified: string;
}

export type ContainerAction = 'start' | 'stop' | 'restart' | 'redeploy' | 'delete';

export const STATE_STYLES: Record<ContainerRecord['state'], string> = {
	running: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
	stopped: 'border-slate-400/30 bg-slate-400/10 text-slate-600 dark:text-slate-400',
	created: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
	error: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300',
};

export const STATE_DOT: Record<ContainerRecord['state'], string> = {
	running: 'bg-emerald-500',
	stopped: 'bg-slate-400',
	created: 'bg-sky-500',
	error: 'bg-rose-500',
};

export const HEALTH_STYLES: Record<ContainerRecord['healthCheck']['status'], string> = {
	healthy: 'text-emerald-600 dark:text-emerald-400',
	unhealthy: 'text-amber-600 dark:text-amber-400',
	unknown: 'text-muted-foreground',
};
