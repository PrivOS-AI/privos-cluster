import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import type { Db } from 'mongodb';

import { MasterRepositories } from './repositories.js';

test('master repositories install additive v3 inventory, lifecycle, replay, and identity indexes', async () => {
	const calls = new Map<string, Array<{ keys: Record<string, unknown>; options: Record<string, unknown> }>>();
	const db = {
		collection: (name: string) => ({
			createIndex: async (keys: Record<string, unknown>, options: Record<string, unknown> = {}) => {
				const collectionCalls = calls.get(name) ?? [];
				collectionCalls.push({ keys, options });
				calls.set(name, collectionCalls);
				return `${name}-${collectionCalls.length}`;
			},
		}),
	} as unknown as Db;
	const repositories = new MasterRepositories(db);
	await repositories.ensureIndexes();

	const hasIndex = (
		collection: string,
		keys: Record<string, unknown>,
		options: Record<string, unknown>,
	) => (calls.get(collection) ?? []).some((call) =>
		isDeepStrictEqual(call.keys, keys) &&
		Object.entries(options).every(([key, value]) =>
			JSON.stringify(call.options[key]) === JSON.stringify(value)));

	assert.equal(hasIndex('apps_master_runtime_resource_inventories', {
		clusterId: 1,
		workspaceId: 1,
		deploymentId: 1,
		generationId: 1,
	}, { unique: true }), true);
	assert.equal(hasIndex('apps_master_apps', {
		workspaceId: 1,
		mcpActiveDeploymentKey: 1,
	}, {
		unique: true,
		partialFilterExpression: { mcpActiveDeploymentKey: { $type: 'string' } },
	}), true);
	assert.equal(hasIndex('apps_master_runtime_resource_inventories', { runtimeInstallationId: 1 }, { unique: true }), true);
	assert.equal(hasIndex('apps_master_lifecycle_operations', { commandJti: 1 }, { unique: true }), true);
	assert.equal(hasIndex('apps_master_lifecycle_operations', { state: 1, nextAttemptAt: 1 }, {}), true);
	assert.equal(hasIndex('apps_master_lifecycle_checkpoints', { checkpointKey: 1 }, { unique: true }), true);
	assert.equal(hasIndex('apps_master_lifecycle_checkpoints', { operationId: 1, sequence: 1 }, { unique: true }), true);
	assert.equal(hasIndex('apps_master_cleanup_results', {
		operationId: 1,
		resourceClass: 1,
		resourceId: 1,
	}, { unique: true }), true);
	assert.equal(hasIndex('apps_master_mcp_protocol_v3_artifact_uses', { expiresAt: 1 }, { expireAfterSeconds: 0 }), true);
	assert.equal(hasIndex('apps_master_mcp_protocol_v3_artifact_uses', { jti: 1 }, { unique: true }), true);
	assert.equal(hasIndex('apps_master_mcp_protocol_v3_artifact_uses', { kind: 1, nonce: 1 }, { unique: true }), true);
	assert.equal(hasIndex('apps_master_mcp_protocol_v3_artifact_uses', {
		kind: 1,
		clusterId: 1,
		workspaceId: 1,
		deploymentId: 1,
		generationId: 1,
	}, { unique: true, partialFilterExpression: { kind: 'deployment-grant' } }), true);
	assert.equal(hasIndex('apps_master_cluster_signing_identities', { clusterId: 1 }, { unique: true }), true);

	// D10: the legacy `subdomain_1` index is now PARTIAL — a host-less v3 app
	// (MCP_V3_NO_DEFAULT_HOST) must never collide with a second one on a
	// shared `null` key.
	assert.equal(hasIndex('apps_master_apps', { subdomain: 1 }, {
		unique: true,
		partialFilterExpression: { subdomain: { $type: 'string' } },
	}), true);
	assert.equal(hasIndex('host_labels', { workspaceId: 1, listingId: 1 }, {}), true);
	assert.equal(hasIndex('host_labels', { state: 1 }, {}), true);
	assert.equal(hasIndex('app_hosts', { workspaceId: 1, appId: 1 }, {}), true);
	assert.equal(hasIndex('app_hosts', { appId: 1, generationId: 1 }, {}), true);
	assert.equal(hasIndex('app_hosts', { cfHostnameId: 1 }, {
		unique: true,
		partialFilterExpression: { cfHostnameId: { $type: 'string' } },
	}), true);
});
