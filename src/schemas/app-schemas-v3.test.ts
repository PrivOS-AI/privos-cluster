import assert from 'node:assert/strict';
import test from 'node:test';

import {
	McpDispatchBodyV3Schema,
	McpRuntimeProvisioningBindingV3Schema,
} from './app-schemas.js';

const provisioningBinding = {
	protocolVersion: 3 as const,
	clusterId: 'cluster-1',
	nodeId: 'node-1',
	workspaceId: 'workspace-1',
	deploymentId: 'deployment-1',
	generationId: 'generation-1',
	generationNumber: 1,
	runtimeInstallationId: 'runtime-1',
	mcpAppId: 'mcp-app-1',
	replicaId: '11111111-1111-4111-8111-111111111111',
	containerId: '22222222-2222-4222-8222-222222222222',
	imageDigest: `sha256:${'a'.repeat(64)}`,
	manifestDigest: `sha256:${'b'.repeat(64)}`,
	approvalReceiptHash: 'c'.repeat(43),
	authorizationEpoch: 1,
	deploymentGrantHash: 'd'.repeat(43),
	resourceManifestHash: 'e'.repeat(43),
	hubOrigin: 'https://hub.example.com',
	hubKid: 'hub-key-thumbprint-1234567890',
	hubPublicJwk: { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y' },
};

test('initial v3 provisioning is roomless and rejects a premature Cluster-local inventory claim', () => {
	assert.equal(McpRuntimeProvisioningBindingV3Schema.parse(provisioningBinding).runtimeInstallationId, 'runtime-1');
	assert.throws(
		() => McpRuntimeProvisioningBindingV3Schema.parse({ ...provisioningBinding, roomId: 'room-1' }),
		/unrecognized/i,
	);
	assert.throws(
		() => McpRuntimeProvisioningBindingV3Schema.parse({
			...provisioningBinding,
			runtimeResourceInventoryHash: 'i'.repeat(43),
		}),
		/unrecognized/i,
	);
});

test('room dispatch requires both the exact runtime parent and authorization child identifiers', () => {
	const rpc = { method: 'tools/call' };
	assert.equal(McpDispatchBodyV3Schema.safeParse({
		assertion: 'signed', rpc, authorizationContext: 'room', runtimeInstallationId: 'runtime-1',
	}).success, false);
	assert.equal(McpDispatchBodyV3Schema.safeParse({
		assertion: 'signed', rpc, authorizationContext: 'room', runtimeInstallationId: 'runtime-1',
		authorizationBindingId: 'binding-1', runtimeResourceInventoryHash: 'i'.repeat(43),
	}).success, true);
	assert.equal(McpDispatchBodyV3Schema.safeParse({
		assertion: 'signed', rpc, authorizationContext: 'workspace', runtimeInstallationId: 'runtime-1',
		authorizationBindingId: 'binding-1', runtimeResourceInventoryHash: 'i'.repeat(43),
	}).success, false);
});
