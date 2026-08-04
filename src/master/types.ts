import type { ContainerResources } from '../types/index.js';
import type { JsonWebKey } from 'node:crypto';
import type {
	ClusterLifecycleCheckpointV3,
	ClusterLifecycleStateV3,
	ClusterRuntimeInventoryAttestationPayloadV3,
	ResourceCleanupResultV3,
	RuntimeResourceDescriptorV3,
	RuntimeResourceKindV3,
} from './protocol-v3.js';

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
	mcpV3Resources?: RuntimeResourceDescriptorV3[];
}

export interface McpV3ProvisioningReplicaPlan {
	nodeId: string;
	replicaId: string;
	containerId: string;
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
	kind?: 'raw' | 'mcp-v2' | 'mcp-v3';
	protocolVersion?: 3;
	mcpDeploymentId?: string;
	/** Present only while this deployment owns the single active v3 parent slot. */
	mcpActiveDeploymentKey?: string;
	mcpGenerationId?: string;
	mcpGenerationNumber?: number;
	mcpRuntimeInstallationId?: string;
	mcpDeploymentGrantJti?: string;
	mcpDeploymentGrantHash?: string;
	mcpApprovalReceiptHash?: string;
	mcpApprovedPermissionCeilingHash?: string;
	mcpAuthorizationEpoch?: number;
	mcpProvisioningNodeIds?: string[];
	mcpProvisioningReplicas?: McpV3ProvisioningReplicaPlan[];
	mcpRoomBindingCount?: number;
	mcpInventoryAttestationEstablishedAt?: Date;
	resourceManifestHash?: string;
	runtimeResourceInventoryHash?: string;
	runtimeResourceInventoryId?: string;
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

export interface RuntimeResourceObservation {
	resourceClass: RuntimeResourceKindV3;
	resourceId: string;
	status: 'EXPECTED' | 'PRESENT' | 'ABSENT' | 'UNKNOWN';
	observedAt: Date;
	reasonCode?: string;
}

export interface RuntimeInventoryAttestationRecord {
	deploymentGrantJti: string;
	jti: string;
	payload: ClusterRuntimeInventoryAttestationPayloadV3;
	compact: string;
	artifactHash: string;
	attestedAt: Date;
}

/**
 * The durable expected-resource record for one immutable runtime generation.
 * It is deliberately independent of live Docker inspection so lifecycle retry
 * can continue after a container has already disappeared.
 */
export interface RuntimeResourceInventory {
	_id: string;
	protocolVersion: 3;
	inventoryId: string;
	clusterId: string;
	workspaceId: string;
	deploymentId: string;
	generationId: string;
	generationNumber: number;
	runtimeInstallationId: string;
	clusterAppId: string;
	manifestDigest: string;
	/** Canonical full cross-plane manifest hash received through Hub. */
	resourceManifestHash: string;
	/** Cluster-local exact runtime descriptor hash, recomputed before cleanup. */
	runtimeResourceInventoryHash?: string;
	expectedResources: RuntimeResourceDescriptorV3[];
	observations: RuntimeResourceObservation[];
	state: 'CAPTURING' | 'READY' | 'MIGRATION_REVIEW_REQUIRED' | 'COMPACTED';
	/** Exact signed second-stage provisioning evidence; immutable once set. */
	runtimeInventoryAttestation?: RuntimeInventoryAttestationRecord;
	createdAt: Date;
	updatedAt: Date;
	compactedAt?: Date;
}

/** Durable, idempotent cleanup saga state. No credential or app payload data. */
export interface ClusterLifecycleOperation {
	_id: string;
	protocolVersion: 3;
	operationId: string;
	activeOperationKey?: string;
	clusterId: string;
	workspaceId: string;
	deploymentId: string;
	generationId: string;
	generationNumber: number;
	runtimeInstallationId: string;
	clusterAppId: string;
	manifestDigest: string;
	resourceManifestHash: string;
	runtimeResourceInventoryHash: string;
	commandJti: string;
	commandHash: string;
	state: ClusterLifecycleStateV3;
	expectedResourceCount: number;
	checkpointCount: number;
	cleanupResultCount: number;
	verifiedResourceCount: number;
	latestCheckpointKey?: string;
	nodeResultHashes: string[];
	finalAcknowledgementJti?: string;
	finalAcknowledgementJws?: string;
	finalAcknowledgementHash?: string;
	errorCode?: string;
	attempts: number;
	nextAttemptAt?: Date;
	createdAt: Date;
	updatedAt: Date;
	completedAt?: Date;
	compactedAt?: Date;
}

/** Immutable checkpoint journal entry for one lifecycle transition attempt. */
export interface ClusterLifecycleCheckpointRecord {
	_id: string;
	protocolVersion: 3;
	checkpointKey: string;
	operationId: string;
	sequence: number;
	checkpoint: ClusterLifecycleCheckpointV3;
	createdAt: Date;
}

/** One immutable terminal observation per exact operation-owned resource. */
export interface ClusterCleanupResultRecord {
	_id: string;
	protocolVersion: 3;
	operationId: string;
	resourceClass: RuntimeResourceKindV3;
	resourceId: string;
	result: ResourceCleanupResultV3;
	recordedAt: Date;
}

export interface McpProtocolV3ArtifactUse {
	_id: string;
	protocolVersion: 3;
	kind: 'deployment-grant' | 'dispatch-assertion' | 'lifecycle-command' | 'node-cleanup-result' | 'cluster-final-acknowledgement';
	jti: string;
	nonce: string;
	clusterId: string;
	workspaceId: string;
	deploymentId: string;
	generationId: string;
	generationNumber: number;
	runtimeInstallationId: string;
	operationId?: string;
	resourceManifestHash: string;
	runtimeResourceInventoryHash?: string;
	issuer: string;
	/** Hash of the schema-validated canonical direct claims. */
	canonicalPayloadHash: string;
	/** Hash of the exact compact JWS bytes received over the wire. */
	compactArtifactHash: string;
	expiresAt: Date;
	createdAt: Date;
}

/** Encrypted-at-rest P-256 identity used only for Cluster evidence signing. */
export interface ClusterSigningIdentityRecord {
	_id: string;
	version: 1;
	clusterId: string;
	identityId: string;
	issuer: string;
	algorithm: 'ES256';
	kid: string;
	publicJwk: JsonWebKey;
	encryptedPrivateJwk: string;
	createdAt: Date;
	updatedAt: Date;
}
