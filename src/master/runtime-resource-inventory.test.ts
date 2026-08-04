import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMcpRuntimeResourceLabelsV3 } from '../security/mcp-resource-labels-v3.js';
import {
	buildExpectedRuntimeResourcesV3,
	buildCapturingRuntimeResourceInventoryV3,
	buildRuntimeResourceInventoryV3,
	finalizeRuntimeResourceInventoryV3,
	normalizeRuntimeResourcesV3,
	runtimeResourceInventoryHashV3,
} from './runtime-resource-inventory.js';

const affinity = {
	clusterId: 'cluster-1',
	workspaceId: 'workspace-1',
	deploymentId: 'deployment-1',
	generationId: 'generation-1',
	generationNumber: 1,
	runtimeInstallationId: 'runtime-1',
	clusterAppId: 'app-1',
	manifestDigest: `sha256:${'a'.repeat(64)}`,
	resourceManifestHash: 'm'.repeat(43),
};

const replica = {
	nodeId: 'node-1',
	nodeIdentityKid: 'node-identity-kid-1',
	replicaId: '11111111-1111-4111-8111-111111111111',
	containerId: 'container-1',
	volumeNames: ['mcp-vol-generation-1-data'],
	brokerBindingIds: ['broker-generation-1-replica-1'],
	brokerSocketIds: ['socket-generation-1-replica-1'],
	serviceDiscoveryIds: ['service-generation-1-replica-1'],
};

test('resource inventory contains exact resources and a deterministic generation-affine hash', () => {
	const resources = buildExpectedRuntimeResourcesV3({
		replicas: [replica],
		ingress: [{ routeId: 'route-generation-1' }],
	});
	assert.deepEqual(resources.map(({ kind, resourceId }) => ({ kind, resourceId })), [
		{ kind: 'BROKER_BINDING', resourceId: 'broker-generation-1-replica-1' },
		{ kind: 'BROKER_SOCKET', resourceId: 'socket-generation-1-replica-1' },
		{ kind: 'CONTAINER', resourceId: 'container-1' },
		{ kind: 'INGRESS', resourceId: 'route-generation-1' },
		{ kind: 'REPLICA', resourceId: '11111111-1111-4111-8111-111111111111' },
		{ kind: 'SERVICE_DISCOVERY', resourceId: 'service-generation-1-replica-1' },
		{ kind: 'VOLUME', resourceId: 'mcp-vol-generation-1-data' },
	]);
	assert.equal(resources.find((resource) => resource.kind === 'REPLICA')?.attributes.nodeIdentityKid, replica.nodeIdentityKid);
	const hash = runtimeResourceInventoryHashV3(affinity, resources);
	assert.match(hash, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(hash, runtimeResourceInventoryHashV3(affinity, [...resources].reverse()));
	assert.notEqual(hash, runtimeResourceInventoryHashV3({ ...affinity, generationId: 'generation-2' }, resources));
	assert.notEqual(hash, runtimeResourceInventoryHashV3({ ...affinity, resourceManifestHash: 'x'.repeat(43) }, resources));
	const createdAt = new Date('2026-08-04T00:00:00.000Z');
	const inventory = buildRuntimeResourceInventoryV3({
		inventoryId: 'inventory-1',
		affinity,
		expectedResources: resources,
		createdAt,
		claimedRuntimeResourceInventoryHash: hash,
	});
	assert.equal(inventory.resourceManifestHash, affinity.resourceManifestHash);
	assert.equal(inventory.runtimeResourceInventoryHash, hash);
	assert.equal(inventory.state, 'READY');
	assert.deepEqual(inventory.observations, []);
	assert.notEqual(inventory.createdAt, createdAt);
	assert.throws(() => buildRuntimeResourceInventoryV3({
		inventoryId: 'inventory-1',
		affinity,
		expectedResources: resources,
		createdAt,
		claimedRuntimeResourceInventoryHash: 'x'.repeat(43),
	}), /runtime_resource_inventory_hash_mismatch/);
});

test('capturing inventory has no premature local hash and finalization is immutable', () => {
	const createdAt = new Date('2026-08-04T00:00:00.000Z');
	const capturing = buildCapturingRuntimeResourceInventoryV3({
		inventoryId: 'inventory-capturing-1',
		affinity,
		createdAt,
	});
	assert.equal(capturing.state, 'CAPTURING');
	assert.equal(capturing.runtimeResourceInventoryHash, undefined);
	assert.deepEqual(capturing.expectedResources, []);
	assert.throws(() => finalizeRuntimeResourceInventoryV3(capturing, [], createdAt), /runtime_resource_inventory_empty/);
	const resources = buildExpectedRuntimeResourcesV3({ replicas: [replica], ingress: [] });
	const ready = finalizeRuntimeResourceInventoryV3(capturing, resources, new Date('2026-08-04T00:00:01.000Z'));
	assert.equal(ready.state, 'READY');
	assert.match(ready.runtimeResourceInventoryHash, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(
		finalizeRuntimeResourceInventoryV3(ready, [...resources].reverse(), ready.updatedAt).runtimeResourceInventoryHash,
		ready.runtimeResourceInventoryHash,
	);
	assert.throws(
		() => finalizeRuntimeResourceInventoryV3(ready, resources.slice(1), ready.updatedAt),
		/runtime_resource_inventory_finalization_conflict/,
	);
});

test('resource construction rejects duplicate exact identities', () => {
	assert.throws(() => buildExpectedRuntimeResourcesV3({
		replicas: [{ ...replica, volumeNames: ['same-volume', 'same-volume'] }],
		ingress: [],
	}), /runtime_resource_identity_duplicate/);
});

test('resource inventory ordering is locale-independent code-unit order', () => {
	const resources = ['ä', 'a', 'Z', 'A'].map((resourceId) => ({
		kind: 'VOLUME' as const,
		resourceId,
		ownershipScope: 'INSTALLATION_GENERATION' as const,
		nodeId: null,
		replicaId: null,
		attributes: {},
	}));
	assert.deepEqual(
		normalizeRuntimeResourcesV3(resources).map((resource) => resource.resourceId),
		['A', 'Z', 'a', 'ä'],
	);
});

test('protocol-v3 resource labels carry immutable affinity but no private key', () => {
	const labels = buildMcpRuntimeResourceLabelsV3({
		protocolVersion: 3,
		clusterId: affinity.clusterId,
		nodeId: 'node-1',
		workspaceId: affinity.workspaceId,
		deploymentId: affinity.deploymentId,
		generationId: affinity.generationId,
		generationNumber: affinity.generationNumber,
		runtimeInstallationId: affinity.runtimeInstallationId,
		mcpAppId: 'mcp-app-1',
		replicaId: replica.replicaId,
		containerId: replica.containerId,
		imageDigest: `sha256:${'b'.repeat(64)}`,
		manifestDigest: affinity.manifestDigest,
		approvalReceiptHash: 'a'.repeat(43),
		authorizationEpoch: 2,
		deploymentGrantHash: 'b'.repeat(43),
		resourceManifestHash: 'c'.repeat(43),
		runtimeResourceInventoryHash: 'd'.repeat(43),
		hubOrigin: 'https://hub.example.com',
		hubKid: 'hub-key-thumbprint',
		hubPublicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
	}, { kind: 'VOLUME', resourceId: 'mcp-vol-generation-1-data' });
	assert.equal(labels['privos.mcp.schema'], '3');
	assert.equal(labels['privos.mcp.deployment'], affinity.deploymentId);
	assert.equal(labels['privos.mcp.generation'], affinity.generationId);
	assert.equal(labels['privos.mcp.runtime-installation'], affinity.runtimeInstallationId);
	assert.equal(labels['privos.mcp.runtime-resource-inventory-hash'], 'd'.repeat(43));
	assert.equal(labels['privos.mcp.resource.kind'], 'VOLUME');
	assert.equal(labels['privos.mcp.resource.id'], 'mcp-vol-generation-1-data');
	assert.equal(JSON.stringify(labels).includes('"d"'), false);
});
