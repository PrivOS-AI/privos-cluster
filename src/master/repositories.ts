import { MongoClient, type Collection, type Db } from 'mongodb';
import type {
	AppLifecycleEvent,
	AppUsageDaily,
	ClusterLifecycleOperation,
	ClusterLifecycleCheckpointRecord,
	ClusterCleanupResultRecord,
	ClusterSigningIdentityRecord,
	MasterApp,
	MasterNode,
	MasterWorkspace,
	McpArtifactUse,
	McpProtocolV3ArtifactUse,
	RuntimeResourceInventory,
} from './types.js';
import type { HostLabelRecord } from './label-namespace.js';
import type { AppHostRecord } from './app-host-registry.js';
import type { MasterMetaRecord } from './host-table-publisher.js';
import { seedHostLabels } from '../migrations/seed-host-labels.js';

export class MasterRepositories {
	readonly workspaces: Collection<MasterWorkspace>;
	readonly nodes: Collection<MasterNode>;
	readonly apps: Collection<MasterApp>;
	readonly lifecycleEvents: Collection<AppLifecycleEvent>;
	readonly usageDaily: Collection<AppUsageDaily>;
	readonly mcpArtifactUses: Collection<McpArtifactUse>;
	readonly runtimeResourceInventories: Collection<RuntimeResourceInventory>;
	readonly clusterLifecycleOperations: Collection<ClusterLifecycleOperation>;
	readonly clusterLifecycleCheckpoints: Collection<ClusterLifecycleCheckpointRecord>;
	readonly clusterCleanupResults: Collection<ClusterCleanupResultRecord>;
	readonly mcpProtocolV3ArtifactUses: Collection<McpProtocolV3ArtifactUse>;
	readonly clusterSigningIdentities: Collection<ClusterSigningIdentityRecord>;
	/** The D10 single label namespace — legacy labels, TENANT and VANITY all share it. */
	readonly hostLabels: Collection<HostLabelRecord>;
	/** D-requirement registry: one row per public hostname, pre-registration included. */
	readonly appHosts: Collection<AppHostRecord>;
	/** Singleton master-scoped counters (routing-table revision, ...). */
	readonly masterMeta: Collection<MasterMetaRecord>;

	constructor(readonly db: Db) {
		this.workspaces = db.collection('apps_master_workspaces');
		this.nodes = db.collection('apps_master_nodes');
		this.apps = db.collection('apps_master_apps');
		this.lifecycleEvents = db.collection('apps_master_lifecycle_events');
		this.usageDaily = db.collection('apps_master_usage_daily');
		this.mcpArtifactUses = db.collection('apps_master_mcp_artifact_uses');
		this.runtimeResourceInventories = db.collection('apps_master_runtime_resource_inventories');
		this.clusterLifecycleOperations = db.collection('apps_master_lifecycle_operations');
		this.clusterLifecycleCheckpoints = db.collection('apps_master_lifecycle_checkpoints');
		this.clusterCleanupResults = db.collection('apps_master_cleanup_results');
		this.mcpProtocolV3ArtifactUses = db.collection('apps_master_mcp_protocol_v3_artifact_uses');
		this.clusterSigningIdentities = db.collection('apps_master_cluster_signing_identities');
		this.hostLabels = db.collection('host_labels');
		this.appHosts = db.collection('app_hosts');
		this.masterMeta = db.collection('apps_master_meta');
	}

	async ensureIndexes(): Promise<void> {
		await Promise.all([
			this.workspaces.createIndex({ workspaceId: 1 }, { unique: true }),
			this.nodes.createIndex({ nodeId: 1 }, { unique: true }),
			this.apps.createIndex({ appId: 1 }, { unique: true }),
			this.apps.createIndex({ workspaceId: 1, listingId: 1 }),
			// PARTIAL: a v3 app with MCP_V3_NO_DEFAULT_HOST on has no `subdomain` at
			// all, and a plain-unique index treats every missing field as the same
			// `null` key — refusing the SECOND host-less app in a workspace. Kept in
			// sync with the migration below, which repoints this same index name on
			// an existing deployment (createIndex here is a no-op once it matches).
			this.apps.createIndex(
				{ subdomain: 1 },
				{ unique: true, partialFilterExpression: { subdomain: { $type: 'string' } } },
			),
			// Reaper sweep: find QUARANTINED apps whose grace window has elapsed.
			this.apps.createIndex({ state: 1, quarantinedAt: 1 }),
			this.apps.createIndex(
				{ workspaceId: 1, mcpDeploymentId: 1, mcpGenerationId: 1, kind: 1 },
				{
					unique: true,
					partialFilterExpression: { kind: 'mcp-v3' },
				},
			),
			this.apps.createIndex(
				{ workspaceId: 1, mcpActiveDeploymentKey: 1 },
				{
					unique: true,
					partialFilterExpression: { mcpActiveDeploymentKey: { $type: 'string' } },
				},
			),
			this.lifecycleEvents.createIndex({ eventId: 1 }, { unique: true }),
			this.lifecycleEvents.createIndex({ workspaceId: 1, at: 1 }),
			this.usageDaily.createIndex({ workspaceId: 1, date: 1 }, { unique: true }),
			// Mongo creates the _id index automatically and rejects an explicit
			// `unique` option for that built-in index.
			this.mcpArtifactUses.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
			this.runtimeResourceInventories.createIndex({ inventoryId: 1 }, { unique: true }),
			this.runtimeResourceInventories.createIndex(
				{ clusterId: 1, workspaceId: 1, deploymentId: 1, generationId: 1 },
				{ unique: true },
			),
			this.runtimeResourceInventories.createIndex({ runtimeInstallationId: 1 }, { unique: true }),
			this.runtimeResourceInventories.createIndex({ resourceManifestHash: 1 }),
			this.runtimeResourceInventories.createIndex(
				{ runtimeResourceInventoryHash: 1 },
				{
					unique: true,
					partialFilterExpression: { runtimeResourceInventoryHash: { $type: 'string' } },
				},
			),
			this.runtimeResourceInventories.createIndex({ 'expectedResources.resourceId': 1 }),
			this.clusterLifecycleOperations.createIndex({ operationId: 1 }, { unique: true }),
			this.clusterLifecycleOperations.createIndex(
				{ workspaceId: 1, runtimeInstallationId: 1, operationId: 1 },
				{ unique: true },
			),
			this.clusterLifecycleOperations.createIndex({ commandJti: 1 }, { unique: true }),
			this.clusterLifecycleOperations.createIndex(
				{ finalAcknowledgementJti: 1 },
				{ unique: true, partialFilterExpression: { finalAcknowledgementJti: { $type: 'string' } } },
			),
			this.clusterLifecycleOperations.createIndex(
				{ activeOperationKey: 1 },
				{
					unique: true,
					partialFilterExpression: { activeOperationKey: { $type: 'string' } },
				},
			),
			this.clusterLifecycleOperations.createIndex({ state: 1, nextAttemptAt: 1 }),
			this.clusterLifecycleCheckpoints.createIndex({ checkpointKey: 1 }, { unique: true }),
			this.clusterLifecycleCheckpoints.createIndex({ operationId: 1, sequence: 1 }, { unique: true }),
			this.clusterLifecycleCheckpoints.createIndex({ operationId: 1, createdAt: 1 }),
			this.clusterCleanupResults.createIndex(
				{ operationId: 1, resourceClass: 1, resourceId: 1 },
				{ unique: true },
			),
			this.clusterCleanupResults.createIndex({ operationId: 1, 'result.status': 1 }),
			this.mcpProtocolV3ArtifactUses.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
			this.mcpProtocolV3ArtifactUses.createIndex({ jti: 1 }, { unique: true }),
			this.mcpProtocolV3ArtifactUses.createIndex({ kind: 1, nonce: 1 }, { unique: true }),
			this.mcpProtocolV3ArtifactUses.createIndex(
				{ kind: 1, clusterId: 1, workspaceId: 1, deploymentId: 1, generationId: 1 },
				{ unique: true, partialFilterExpression: { kind: 'deployment-grant' } },
			),
			this.mcpProtocolV3ArtifactUses.createIndex(
				{ workspaceId: 1, deploymentId: 1, generationId: 1, kind: 1 },
			),
			this.clusterSigningIdentities.createIndex({ clusterId: 1 }, { unique: true }),
			this.clusterSigningIdentities.createIndex({ kid: 1 }, { unique: true }),
			this.hostLabels.createIndex({ workspaceId: 1, listingId: 1 }),
			this.hostLabels.createIndex({ state: 1 }),
			this.appHosts.createIndex({ workspaceId: 1, appId: 1 }),
			this.appHosts.createIndex({ appId: 1, generationId: 1 }),
			this.appHosts.createIndex({ state: 1 }),
			this.appHosts.createIndex(
				{ cfHostnameId: 1 },
				{ unique: true, partialFilterExpression: { cfHostnameId: { $type: 'string' } } },
			),
		]);
	}
}

export async function connectMasterRepositories(
	url: string,
	dbName: string,
): Promise<{ client: MongoClient; repositories: MasterRepositories }> {
	const client = new MongoClient(url);
	await client.connect();
	const db = client.db(dbName);
	// MUST run before `ensureIndexes`: it repoints `apps.subdomain_1` from a
	// plain-unique to a partial-unique index, and `ensureIndexes` recreating the
	// OLD shape first would just have this migration redo the same work a
	// moment later — harmless, but the ordering is the contract the phase-3
	// spec calls for, so it is kept explicit rather than relying on idempotency
	// to paper over a reordering.
	await seedHostLabels(db);
	const repositories = new MasterRepositories(db);
	await repositories.ensureIndexes();
	return { client, repositories };
}
