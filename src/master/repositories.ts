import { MongoClient, type Collection, type Db } from 'mongodb';
import type {
	AppLifecycleEvent,
	AppUsageDaily,
	MasterApp,
	MasterNode,
	MasterWorkspace,
	McpArtifactUse,
} from './types.js';

export class MasterRepositories {
	readonly workspaces: Collection<MasterWorkspace>;
	readonly nodes: Collection<MasterNode>;
	readonly apps: Collection<MasterApp>;
	readonly lifecycleEvents: Collection<AppLifecycleEvent>;
	readonly usageDaily: Collection<AppUsageDaily>;
	readonly mcpArtifactUses: Collection<McpArtifactUse>;

	constructor(readonly db: Db) {
		this.workspaces = db.collection('apps_master_workspaces');
		this.nodes = db.collection('apps_master_nodes');
		this.apps = db.collection('apps_master_apps');
		this.lifecycleEvents = db.collection('apps_master_lifecycle_events');
		this.usageDaily = db.collection('apps_master_usage_daily');
		this.mcpArtifactUses = db.collection('apps_master_mcp_artifact_uses');
	}

	async ensureIndexes(): Promise<void> {
		await Promise.all([
			this.workspaces.createIndex({ workspaceId: 1 }, { unique: true }),
			this.nodes.createIndex({ nodeId: 1 }, { unique: true }),
			this.apps.createIndex({ appId: 1 }, { unique: true }),
			this.apps.createIndex({ workspaceId: 1, listingId: 1 }),
			this.apps.createIndex({ subdomain: 1 }, { unique: true }),
			this.lifecycleEvents.createIndex({ eventId: 1 }, { unique: true }),
			this.lifecycleEvents.createIndex({ workspaceId: 1, at: 1 }),
			this.usageDaily.createIndex({ workspaceId: 1, date: 1 }, { unique: true }),
			// Mongo creates the _id index automatically and rejects an explicit
			// `unique` option for that built-in index.
			this.mcpArtifactUses.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
		]);
	}
}

export async function connectMasterRepositories(
	url: string,
	dbName: string,
): Promise<{ client: MongoClient; repositories: MasterRepositories }> {
	const client = new MongoClient(url);
	await client.connect();
	const repositories = new MasterRepositories(client.db(dbName));
	await repositories.ensureIndexes();
	return { client, repositories };
}
