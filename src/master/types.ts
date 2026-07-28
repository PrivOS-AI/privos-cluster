import type { ContainerResources } from '../types/index.js';

export type AvailabilityTier = 'single' | 'ha';
export type NodeStatus = 'ACTIVE' | 'DRAINING' | 'RETIRED';

export interface WorkspaceQuota {
	maxMemoryMb: number;
	maxCpus: number;
	maxApps: number;
}

export interface MasterWorkspace {
	workspaceId: string;
	keyHash: string;
	encryptedKey: string;
	quota: WorkspaceQuota;
	defaultAvailabilityTier: AvailabilityTier;
	status: 'ACTIVE' | 'REVOKED';
	createdAt: Date;
	updatedAt: Date;
}

export interface NodeCapacity {
	memoryMb: number;
	cpus: number;
	diskBytes: number;
}

export interface MasterNode {
	nodeId: string;
	portalNodeId?: string;
	url: string;
	region: string;
	failureDomain: string;
	capacity: NodeCapacity;
	status: NodeStatus;
	keyId: string;
	encryptedFleetKey: string;
	tunnelId?: string;
	lastHealth?: Date;
	createdAt: Date;
	updatedAt: Date;
}

export interface AppReplica {
	replicaId: string;
	nodeId: string;
	containerId: string;
	state: string;
}

export interface MasterApp {
	appId: string;
	workspaceId: string;
	listingId: string;
	versionDigest: string;
	image: string;
	imageDigest: string;
	resources: ContainerResources;
	availabilityTier: AvailabilityTier;
	stateless: boolean;
	subdomain: string;
	uiUrl: string;
	replicas: AppReplica[];
	state: string;
	createdAt: Date;
	updatedAt: Date;
}

export type LifecycleEventType = 'STARTED' | 'STOPPED' | 'REDEPLOYED' | 'REMOVED';

export interface AppLifecycleEvent {
	eventId: string;
	workspaceId: string;
	appId: string;
	replicaId: string;
	type: LifecycleEventType;
	resources: ContainerResources;
	at: Date;
}
