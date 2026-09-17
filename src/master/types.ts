import type { ContainerResources } from '../types/index.js';
import type { JsonWebKey } from 'node:crypto';
import type {
	ClusterLifecycleCheckpointV3,
	ClusterLifecycleStateV3,
	ClusterRuntimeInventoryAttestationPayloadV3,
	ResourceCleanupResultV3,
	RuntimeResourceDescriptorV3,
	RuntimeResourceKindV3,
} from '../protocol/protocol-v3.js';

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
	/** Operator-supplied non-secret environment. Secret values live encrypted. */
	envVars: Record<string, string>;
	/** AES-GCM blob of the secret subset, sealed with the master key. */
	secretEnvVarsEnc?: string;
	/** Names inside the sealed blob, so the set is auditable without opening it. */
	secretEnvKeys?: string[];
	/** Configuration generation currently running on every replica. */
	appliedConfigEpoch?: number;
	appliedConfigAt?: Date;
	volumes: Array<{ name: 'data'; mountPath: string; sizeMb?: number }>;
	storageBytes: number;
	availabilityTier: AvailabilityTier;
	stateless: boolean;
	subdomain: string;
	uiUrl: string;
	replicas: AppReplica[];
	/** RUNNING | STOPPED | REMOVING | REMOVED | QUARANTINED. QUARANTINED = the
	 * workspace was revoked (offboard/purge): the app is stopped but retained
	 * (container + volumes) and permanently reaped only after the grace window. */
	state: string;
	/** Set when the app enters QUARANTINED; the reaper removes it after the grace
	 * window elapses. Cleared on un-quarantine (workspace resurrected in grace). */
	quarantinedAt?: Date;
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
	/**
	 * Set when the app was stopped because its WORKSPACE was suspended (dunning,
	 * offboard, manual stop) rather than by anything the app itself did. Resume
	 * restarts exactly the apps carrying this marker, so an app an operator had
	 * deliberately stopped beforehand stays stopped.
	 */
	suspendedWithWorkspace?: boolean;
	mcpInventoryAttestationEstablishedAt?: Date;
	resourceManifestHash?: string;
	runtimeResourceInventoryHash?: string;
	runtimeResourceInventoryId?: string;
	mcpInstallationId?: string;
	mcpAppId?: string;
	manifestDigest?: string;
	receiptHash?: string;
	grantEpoch?: number;
	/** Image revision currently running (D1: bumped by every swap, including a rollback). */
	mcpAppliedRevision?: number;
	/** The redelivery guard spent to reach `mcpAppliedRevision`; always equal to it (see protocol-v3.ts). */
	mcpAppliedUpgradeEpoch?: number;
	/** Named revert target for the currently-applied revision (D4) — NOT recomputed. */
	mcpPreviousManifestDigest?: string;
	mcpPreviousImageDigest?: string;
	/** How the most recent upgrade actually swapped the container; echoed on an idempotent replay. */
	mcpLastSwapStrategy?: 'ROLLING' | 'STOP_THEN_CREATE';
	/** Most recent OOM kill observed on any replica's container, copied from the
	 * agent's container listing during reconcile. Informational only — it never
	 * gates a lifecycle transition, and is not cleared on a later successful start. */
	lastOomAt?: Date;
}

export interface McpArtifactUse {
	_id: string;
	kind: 'deployment-grant' | 'dispatch-assertion';
	workspaceId: string;
	installationId: string;
	expiresAt: Date;
	createdAt: Date;
}

/**
 * STARTED/STOPPED/REDEPLOYED/REMOVED/QUARANTINED are per-REPLICA operational
 * events (ops metrics: ramGbHours/cpuHours, and the reap/revoke lifecycle).
 * INSTALLED/UNINSTALLED/REPLICAS_CHANGED/RESIZED are per-APP billing events,
 * distinct from replica churn: an app is "installed" once (at first
 * activation) and stays installed across restarts, redeploys, and individual
 * replica STARTED/STOPPED — only an explicit uninstall or a workspace-revoke
 * QUARANTINED event closes the billable interval. RESIZED re-bases the open
 * interval's resources the same way REPLICAS_CHANGED re-bases its replica
 * count — a size-package change mid-day is priced at the largest resources
 * held that day (the portal prices it; the aggregator only carries segments).
 */
export type LifecycleEventType =
	| 'STARTED'
	| 'STOPPED'
	| 'REDEPLOYED'
	| 'REMOVED'
	| 'QUARANTINED'
	| 'INSTALLED'
	| 'UNINSTALLED'
	| 'REPLICAS_CHANGED'
	| 'RESIZED';

export interface AppLifecycleEvent {
	eventId: string;
	workspaceId: string;
	appId: string;
	/** Absent on app-level events (INSTALLED/UNINSTALLED/REPLICAS_CHANGED, and
	 * a revoke-teardown QUARANTINED), which describe the app as a whole rather
	 * than one replica. */
	replicaId?: string;
	type: LifecycleEventType;
	resources: ContainerResources;
	/** Carried on INSTALLED (and REPLICAS_CHANGED, if storage changed with it)
	 * so a billing rollup can re-derive storage from events alone, without
	 * reading the current (mutable) app document. */
	storageBytes?: number;
	/** App-level replica count at the time of the event (INSTALLED/REPLICAS_CHANGED). */
	replicaCount?: number;
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
		/** Largest resource reservation billed for this app on this day — see
		 * `aggregateWorkspaceDay` for why "largest observed" is the correct
		 * pricing input. */
		resources: { memoryMb: number; cpus: number; tmpSizeMb?: number };
		/** Largest replica count billed for this app on this day. */
		replicaCount: number;
		/** Share of the UTC day (0-1) the app was installed-and-running. */
		installedDayFraction: number;
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
	kind:
		| 'deployment-grant'
		| 'dispatch-assertion'
		| 'lifecycle-command'
		| 'reconfigure-command'
		| 'upgrade-command'
		| 'node-cleanup-result'
		| 'cluster-final-acknowledgement';
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
