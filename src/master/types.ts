import type { ContainerResources } from '../types/index.js';
import type { JsonWebKey } from 'node:crypto';

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
	mcpHubIdentityKid?: string;
	mcpHubIdentityPublicJwk?: JsonWebKey;
	mcpHubIdentityEnrolledAt?: Date;
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
	mcpIdentityKid?: string;
	mcpIdentityPublicJwk?: JsonWebKey;
}

export interface AppReplica {
	replicaId: string;
	nodeId: string;
	containerId: string;
	state: string;
	mcpNodeIdentity?: { kid: string; publicJwk: JsonWebKey };
}

export interface MasterApp {
	appId: string;
	workspaceId: string;
	listingId: string;
	versionDigest: string;
	image: string;
	imageDigest: string;
	resources: ContainerResources;
	port: number;
	envVars: Record<string, string>;
	volumes: Array<{ name: 'data'; mountPath: string; sizeMb?: number }>;
	storageBytes: number;
	availabilityTier: AvailabilityTier;
	stateless: boolean;
	subdomain: string;
	uiUrl: string;
	replicas: AppReplica[];
	state: string;
	createdAt: Date;
	updatedAt: Date;
	kind?: 'raw' | 'mcp-v2';
	mcpInstallationId?: string;
	mcpAppId?: string;
	manifestDigest?: string;
	receiptHash?: string;
	grantEpoch?: number;
}

export interface McpArtifactUse {
	_id: string;
	kind: 'deployment-grant' | 'dispatch-assertion';
	workspaceId: string;
	installationId: string;
	expiresAt: Date;
	createdAt: Date;
}

export type LifecycleEventType = 'STARTED' | 'STOPPED' | 'REDEPLOYED' | 'REMOVED';

export interface AppLifecycleEvent {
	eventId: string;
	workspaceId: string;
	appId: string;
	replicaId: string;
	type: LifecycleEventType;
	resources: ContainerResources;
	storageBytes?: number;
	at: Date;
}

export interface AppUsageDaily {
	workspaceId: string;
	date: Date;
	ramGbHours: number;
	cpuHours: number;
	storageGbDay: number;
	perApp: Array<{
		appId: string;
		ramGbHours: number;
		cpuHours: number;
		storageGbDay: number;
	}>;
	computedAt: Date;
}
