import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import type { NodeIdentity } from '../security/node-identity.js';
import { McpBrokerManager } from './mcp-broker.js';
import { getAppNetworkName } from './settings-service.js';

const replicaId = '11111111-1111-4111-8111-111111111111';
const containerId = '22222222-2222-4222-8222-222222222222';
const networkName = getAppNetworkName('workspace-1');
const hubPublicJwk = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };

const finalized = {
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
	authorizationEpoch: 7,
	deploymentGrantHash: 'd'.repeat(43),
	resourceManifestHash: 'e'.repeat(43),
	hubOrigin: 'https://hub.example.com',
	hubKid: 'hub-key-thumbprint-1234567890',
	hubPublicJwk,
	networkName,
	runtimeResourceInventoryHash: 'i'.repeat(43),
};

const labels = {
	'privos.workspace': finalized.workspaceId,
	'privos.id': containerId,
	'privos.mcp.schema': '3',
	'privos.mcp.cluster': finalized.clusterId,
	'privos.mcp.node': finalized.nodeId,
	'privos.mcp.workspace': finalized.workspaceId,
	'privos.mcp.deployment': finalized.deploymentId,
	'privos.mcp.generation': finalized.generationId,
	'privos.mcp.generation-number': String(finalized.generationNumber),
	'privos.mcp.runtime-installation': finalized.runtimeInstallationId,
	'privos.mcp.app': finalized.mcpAppId,
	'privos.mcp.replica': replicaId,
	'privos.mcp.image.digest': finalized.imageDigest,
	'privos.mcp.manifest.digest': finalized.manifestDigest,
	'privos.mcp.approval-receipt': finalized.approvalReceiptHash,
	'privos.mcp.authorization-epoch': String(finalized.authorizationEpoch),
	'privos.mcp.deployment-grant-hash': finalized.deploymentGrantHash,
	'privos.mcp.resource-manifest-hash': finalized.resourceManifestHash,
	'privos.mcp.hub-origin': finalized.hubOrigin,
	'privos.mcp.hub-kid': finalized.hubKid,
	'privos.mcp.hub-jwk': JSON.stringify(hubPublicJwk),
};

async function setup(t: test.TestContext) {
	const temporaryRoot = await fs.mkdtemp(path.join('/tmp', 'privos-mcp-store-'));
	t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
	const brokerRoot = path.join(temporaryRoot, 'broker');
	const stateRoot = path.join(temporaryRoot, 'state');
	const make = (state: string | undefined = stateRoot) =>
		new McpBrokerManager(brokerRoot, {} as NodeIdentity, async () => ({}), state);
	const managers: McpBrokerManager[] = [];
	const track = (manager: McpBrokerManager) => { managers.push(manager); return manager; };
	t.after(async () => { await Promise.all(managers.map((manager) => manager.closeAll())); });
	return {
		brokerRoot,
		stateRoot,
		make: (state?: string) => track(make(state)),
		legacyFile: path.join(brokerRoot, replicaId, 'binding-v3.json'),
		storeFile: path.join(stateRoot, `${replicaId}.json`),
	};
}

test('a finalized binding is written to the store and the legacy folder', async (t) => {
	const env = await setup(t);
	const manager = env.make();
	await manager.prepare(replicaId);
	await manager.register(finalized);
	const store = await fs.readFile(env.storeFile, 'utf8');
	assert.equal(store, await fs.readFile(env.legacyFile, 'utf8'));
	assert.equal((await fs.stat(env.storeFile)).mode & 0o777, 0o600);
	assert.equal((await fs.stat(env.stateRoot)).mode & 0o777, 0o700);
});

test('after the tmpfs folder is wiped the binding is restored from the store', async (t) => {
	const env = await setup(t);
	const first = env.make();
	await first.prepare(replicaId);
	await first.register(finalized);
	await first.closeAll();
	await fs.rm(env.brokerRoot, { recursive: true, force: true });

	const replacement = env.make();
	await replacement.prepare(replicaId);
	await replacement.restoreFinalizedV3(labels, 'docker-2');
	assert.equal(replacement.isBound(replicaId), true);
});

test('a legacy-only binding migrates into the store and the legacy copy is kept', async (t) => {
	const env = await setup(t);
	const legacyOnly = new McpBrokerManager(env.brokerRoot, {} as NodeIdentity, async () => ({}));
	await legacyOnly.prepare(replicaId);
	await legacyOnly.register(finalized);
	await legacyOnly.closeAll();
	await assert.rejects(fs.stat(env.storeFile));

	const upgraded = env.make();
	await upgraded.restoreFinalizedV3(labels, 'docker-1');
	assert.equal(await fs.readFile(env.storeFile, 'utf8'), await fs.readFile(env.legacyFile, 'utf8'));
	assert.equal((await fs.stat(env.legacyFile)).isFile(), true);
});

test('an unsafe legacy binding is refused: symlink, wrong mode', async (t) => {
	const env = await setup(t);
	const seed = new McpBrokerManager(env.brokerRoot, {} as NodeIdentity, async () => ({}));
	await seed.prepare(replicaId);
	await seed.register(finalized);
	await seed.closeAll();
	const manager = env.make();

	await fs.chmod(env.legacyFile, 0o644);
	await assert.rejects(manager.restoreFinalizedV3(labels, 'docker-1'), /persisted_mcp_v3_broker_binding_unsafe/);
	await assert.rejects(fs.stat(env.storeFile));

	await fs.chmod(env.legacyFile, 0o600);
	const target = path.join(env.brokerRoot, 'elsewhere.json');
	await fs.rename(env.legacyFile, target);
	await fs.symlink(target, env.legacyFile);
	await assert.rejects(manager.restoreFinalizedV3(labels, 'docker-1'), /persisted_mcp_v3_broker_binding_unsafe/);
	await assert.rejects(fs.stat(env.storeFile));
});

test('with neither copy present the raw ENOENT survives so provisioning registration still happens', async (t) => {
	const env = await setup(t);
	const manager = env.make();
	await manager.prepare(replicaId);
	await assert.rejects(
		manager.restoreFinalizedV3(labels, 'docker-1'),
		(error: NodeJS.ErrnoException) => error.code === 'ENOENT',
	);
	const { runtimeResourceInventoryHash: _unused, ...provisioning } = finalized;
	await manager.restoreOrRegisterProvisioningV3({ ...provisioning, runtimeResourceInventoryHash: undefined }, labels);
	assert.equal(manager.isBound(replicaId), true);
});

test('cleanup removes the store file', async (t) => {
	const env = await setup(t);
	const manager = env.make();
	await manager.prepare(replicaId);
	await manager.register(finalized);
	await manager.cleanup(replicaId);
	await assert.rejects(fs.stat(env.storeFile));
	await assert.rejects(fs.stat(env.legacyFile));
});

test('a traversal replica id is refused before any filesystem call', async (t) => {
	const env = await setup(t);
	const manager = env.make();
	for (const bad of ['../../etc/passwd', `${replicaId}/../x`, '', 'not-a-uuid']) {
		await assert.rejects(manager.cleanup(bad), /replica_id_invalid/);
		await assert.rejects(manager.restoreFinalizedV3({ ...labels, 'privos.mcp.replica': bad }, 'd'), /replica_id_invalid|binding_invalid/);
	}
	await assert.rejects(fs.stat(env.stateRoot));
	await assert.rejects(fs.stat(env.brokerRoot));
});

test('the orphan sweep removes store files with no container and interrupted writes only', async (t) => {
	const env = await setup(t);
	const kept = '33333333-3333-4333-8333-333333333333';
	const orphan = '44444444-4444-4444-8444-444444444444';
	await fs.mkdir(env.stateRoot, { recursive: true });
	await fs.writeFile(path.join(env.stateRoot, `${kept}.json`), '{}');
	await fs.writeFile(path.join(env.stateRoot, `${orphan}.json`), '{}');
	await fs.writeFile(path.join(env.stateRoot, `${kept}.json.next-1-x`), '{}');
	await fs.writeFile(path.join(env.stateRoot, 'notes.txt'), 'stray');
	const removed = await env.make().sweepOrphanStore(new Set([kept]));
	assert.deepEqual(removed.sort(), [`${kept}.json.next-1-x`, `${orphan}.json`].sort());
	assert.deepEqual((await fs.readdir(env.stateRoot)).sort(), [`${kept}.json`, 'notes.txt']);
	assert.deepEqual(await new McpBrokerManager(env.brokerRoot, {} as NodeIdentity, async () => ({})).sweepOrphanStore(new Set()), []);
});

test('a corrupt store file is refused rather than silently replaced by the legacy copy', async (t) => {
	const env = await setup(t);
	const manager = env.make();
	await manager.prepare(replicaId);
	await manager.register(finalized);
	await manager.closeAll();
	await fs.writeFile(env.storeFile, '{not json');
	await assert.rejects(manager.restoreFinalizedV3(labels, 'docker-1'), SyntaxError);
});

test('a conflicting store copy blocks a different finalized binding', async (t) => {
	const env = await setup(t);
	const manager = env.make();
	await manager.prepare(replicaId);
	await manager.register(finalized);
	await assert.rejects(
		manager.register({ ...finalized, runtimeResourceInventoryHash: 'j'.repeat(43) }),
		/persisted_mcp_v3_broker_binding_conflict/,
	);
});
