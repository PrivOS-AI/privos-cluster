import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { NodeIdentity } from '../security/node-identity.js';
import { McpBrokerManager } from './mcp-broker.js';
import { getAppNetworkName } from './settings-service.js';

async function requestBroker(socketPath: string, request: unknown): Promise<any> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let response = '';
		socket.setEncoding('utf8');
		socket.once('error', reject);
		socket.on('data', (chunk) => { response += chunk; });
		socket.on('end', () => {
			try { resolve(JSON.parse(response)); } catch (error) { reject(error); }
		});
		socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`));
	});
}

test('broker keeps its host root private while making the bind-mounted replica directory traversable', async (t) => {
	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'privos-mcp-broker-'));
	t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
	const brokerRoot = path.join(temporaryRoot, 'broker');
	const manager = new McpBrokerManager(brokerRoot, {} as NodeIdentity, async () => ({}));

	const replicaId = '11111111-1111-4111-8111-111111111111';
	const mount = await manager.prepare(replicaId);
	const rootMode = (await fs.stat(brokerRoot)).mode & 0o777;
	const mountMode = (await fs.stat(mount.source)).mode & 0o777;

	assert.equal(rootMode, 0o700);
	assert.equal(mountMode, 0o711);
	assert.equal(mount.target, '/run/privos');
});

test('v3 broker socket is allocated before inventory finalization and exact final binding survives process restart', async (t) => {
	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'privos-mcp-broker-v3-'));
	t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
	const brokerRoot = path.join(temporaryRoot, 'broker');
	const replicaId = '11111111-1111-4111-8111-111111111111';
	const containerId = '22222222-2222-4222-8222-222222222222';
	const networkName = getAppNetworkName('workspace-1');
	const baseBinding = {
		protocolVersion: 3 as const,
		clusterId: 'cluster-1',
		nodeId: 'node-1',
		workspaceId: 'workspace-1',
		deploymentId: 'deployment-1',
		generationId: 'generation-1',
		generationNumber: 1,
		runtimeInstallationId: 'runtime-1',
		mcpAppId: 'mcp-app-1',
		replicaId,
		containerId,
		dockerContainerId: 'docker-1',
		imageDigest: `sha256:${'a'.repeat(64)}`,
		manifestDigest: `sha256:${'b'.repeat(64)}`,
		approvalReceiptHash: 'c'.repeat(43),
		authorizationEpoch: 1,
		deploymentGrantHash: 'd'.repeat(43),
		resourceManifestHash: 'e'.repeat(43),
		hubOrigin: 'https://hub.example.com',
		hubKid: 'hub-key-thumbprint-1234567890',
		hubPublicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
		networkName,
	};
	const labels = {
		'privos.workspace': baseBinding.workspaceId,
		'privos.id': containerId,
		'privos.mcp.schema': '3',
		'privos.mcp.cluster': baseBinding.clusterId,
		'privos.mcp.node': baseBinding.nodeId,
		'privos.mcp.workspace': baseBinding.workspaceId,
		'privos.mcp.deployment': baseBinding.deploymentId,
		'privos.mcp.generation': baseBinding.generationId,
		'privos.mcp.generation-number': String(baseBinding.generationNumber),
		'privos.mcp.runtime-installation': baseBinding.runtimeInstallationId,
		'privos.mcp.app': baseBinding.mcpAppId,
		'privos.mcp.replica': replicaId,
		'privos.mcp.image.digest': baseBinding.imageDigest,
		'privos.mcp.manifest.digest': baseBinding.manifestDigest,
		'privos.mcp.approval-receipt': baseBinding.approvalReceiptHash,
		'privos.mcp.authorization-epoch': String(baseBinding.authorizationEpoch),
		'privos.mcp.deployment-grant-hash': baseBinding.deploymentGrantHash,
		'privos.mcp.resource-manifest-hash': baseBinding.resourceManifestHash,
		'privos.mcp.hub-origin': baseBinding.hubOrigin,
		'privos.mcp.hub-kid': baseBinding.hubKid,
		'privos.mcp.hub-jwk': JSON.stringify(baseBinding.hubPublicJwk),
	};
	const inspect = async () => ({
		State: { Running: true },
		Config: { Labels: labels },
		NetworkSettings: { Networks: { [networkName]: {} } },
	});
	let signedPayload: Record<string, unknown> | undefined;
	let signedProtocolVersion: number | undefined;
	const first = new McpBrokerManager(brokerRoot, {
		sign: async (payload: Record<string, unknown>, typ: string, protocolVersion?: number) => {
			assert.equal(typ, 'privos-node-attestation+jws');
			signedPayload = payload;
			signedProtocolVersion = protocolVersion;
			return 'signed-attestation';
		},
	} as unknown as NodeIdentity, inspect);
	await first.prepare(replicaId);
	await first.registerProvisioningV3({ ...baseBinding, runtimeResourceInventoryHash: undefined });
	const socketPath = path.join(brokerRoot, replicaId, 'identity.sock');
	assert.equal((await fs.stat(socketPath)).isSocket(), true);
	const dpopPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const brokerRequest = {
		op: 'attest',
		publicJwk: dpopPair.publicKey.export({ format: 'jwk' }),
		nonce: 'workload-nonce-123456',
	};
	assert.deepEqual(await requestBroker(socketPath, brokerRequest), {
		ok: false,
		error: 'runtime_inventory_not_established',
	});

	const finalized = { ...baseBinding, runtimeResourceInventoryHash: 'i'.repeat(43) };
	await first.register(finalized);
	assert.equal((await requestBroker(socketPath, brokerRequest)).attestation, 'signed-attestation');
	assert.equal(signedProtocolVersion, 3);
	assert.equal(signedPayload?.runtimeInstallationId, 'runtime-1');
	assert.equal(signedPayload?.runtimeResourceInventoryHash, 'i'.repeat(43));
	assert.equal((await fs.stat(path.join(brokerRoot, replicaId, 'binding-v3.json'))).isFile(), true);
	await first.closeAll();

	const replacement = new McpBrokerManager(brokerRoot, {} as NodeIdentity, inspect);
	await replacement.restoreFinalizedV3(labels, 'docker-1');
	assert.equal((await fs.stat(path.join(brokerRoot, replicaId, 'identity.sock'))).isSocket(), true);
	await assert.rejects(
		replacement.register({ ...finalized, runtimeResourceInventoryHash: 'j'.repeat(43) }),
		/persisted_mcp_v3_broker_binding_conflict/,
	);
	await replacement.closeAll();
});
