/**
 * Which securityProfile every container-creating lifecycle path hands to
 * createAppContainer: a request value applies, explicit null removes, an absent
 * key keeps the running container's label (install has nothing to keep, so absent is none).
 * Only the Docker-touching containerManager methods are mocked.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

const brokerRoot = await fs.mkdtemp(path.join('/tmp', 'mcp-broker-profile-test-'));
process.env.MCP_BROKER_ROOT = brokerRoot;

const { containerManager, docker } = await import('../docker/index.js');
const { mcpBrokerManager } = await import('./mcp-broker.js');
const { deployManagedApp, reconfigureManagedAppV3, rollingRedeployContainer } = await import('./lifecycle-service.js');

const digest = `sha256:${'5'.repeat(64)}`;
const replicaId = '99999999-9999-4999-8999-999999999999';
const containerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function startHealthServer(): Promise<{ port: number; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			resolve({ port, close: () => new Promise((r) => server.close(() => r(undefined))) });
		});
	});
}

function labelsFor(port: number, extra: Record<string, string> = {}): Record<string, string> {
	return {
		'privos.managed': 'true', 'privos.id': containerId, 'privos.app-id': 'cluster-app-1',
		'privos.workspace': 'workspace-1', 'privos.image': 'registry.example/app', 'privos.tag': 'latest',
		'privos.image.digest': digest, 'privos.port': String(port),
		'privos.resources': JSON.stringify({ memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 }),
		'privos.env': '{}', 'privos.subdomain': '', 'privos.domain': '',
		'privos.created-at': new Date().toISOString(),
		'privos.health.path': '/health', 'privos.health.max-fails': '3', 'privos.health.restart': 'true',
		...extra,
	};
}

const mcpBinding = {
	protocolVersion: 3 as const, clusterId: 'cluster-1', nodeId: 'node-1', workspaceId: 'workspace-1',
	deploymentId: 'deployment-1', generationId: 'generation-1', generationNumber: 1,
	runtimeInstallationId: 'runtime-1', mcpAppId: 'mcp-app-1', replicaId, containerId,
	imageDigest: digest, manifestDigest: digest, approvalReceiptHash: 'b'.repeat(43), authorizationEpoch: 1,
	deploymentGrantHash: 'g'.repeat(43), resourceManifestHash: 'r'.repeat(43),
};

const mcpLabels: Record<string, string> = {
	'privos.mcp.schema': '3', 'privos.mcp.cluster': 'cluster-1', 'privos.mcp.node': 'node-1',
	'privos.mcp.deployment': 'deployment-1', 'privos.mcp.generation': 'generation-1',
	'privos.mcp.generation-number': '1', 'privos.mcp.runtime-installation': 'runtime-1',
	'privos.mcp.app': 'mcp-app-1', 'privos.mcp.replica': replicaId, 'privos.mcp.manifest.digest': digest,
	'privos.mcp.resource-manifest-hash': 'r'.repeat(43), 'privos.mcp.approval-receipt': 'b'.repeat(43),
	'privos.mcp.authorization-epoch': '1', 'privos.mcp.deployment-grant-hash': 'g'.repeat(43),
	'privos.mcp.image.digest': digest, 'privos.mcp.hub-origin': 'https://hub.example.com',
	'privos.mcp.hub-kid': 'kid-1', 'privos.mcp.hub-jwk': JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }),
};

/** In-memory Docker: records the securityProfile of every createAppContainer call. */
async function harness(t: import('node:test').TestContext, oldLabels?: (port: number) => Record<string, string>) {
	const health = await startHealthServer();
	t.after(async () => {
		await health.close();
		await mcpBrokerManager.closeAll();
	});
	const registry = new Map<string, { Config: { Labels: Record<string, string> }; Mounts: unknown[] }>();
	if (oldLabels) registry.set('docker-old', { Config: { Labels: oldLabels(health.port) }, Mounts: [] });
	const profiles: Array<string | null> = [];
	let created = 0;

	t.mock.method(docker, 'info', async () => ({ MemTotal: 8 * 1024 * 1024 * 1024, NCPU: 4 }));
	t.mock.method(containerManager, 'pullImage', async () => undefined);
	t.mock.method(containerManager, 'stopContainer', async () => undefined);
	t.mock.method(containerManager, 'removeContainer', async (id: string) => { registry.delete(id); });
	t.mock.method(containerManager, 'startContainer', async () => undefined);
	t.mock.method(containerManager, 'getContainerIp', async () => '127.0.0.1');
	t.mock.method(containerManager, 'createAppContainer', async (cfg: any) => {
		created += 1;
		profiles.push(cfg.securityProfile);
		const id = `docker-new-${created}`;
		registry.set(id, {
			Config: { Labels: { ...labelsFor(health.port, mcpLabels), ...(cfg.mcpV3Binding ? {} : { 'privos.mcp.schema': '' }), ...(cfg.securityProfile ? { 'privos.securityProfile': cfg.securityProfile } : {}) } },
			Mounts: [],
		});
		return { containerId: id, containerName: id, hostPort: 0 };
	});
	t.mock.method(containerManager, 'listContainers', async () => [...registry.entries()].map(([Id, info]) => ({
		Id, Names: [`/${Id}`], Image: 'registry.example/app:latest', Labels: info.Config.Labels,
		State: 'running', Created: Math.floor(Date.now() / 1000), Ports: [], Mounts: [],
		NetworkSettings: { Networks: {} },
	})));
	t.mock.method(containerManager, 'inspectContainer', async (id: string) => {
		const info = registry.get(id);
		if (!info) throw new Error(`no such container: ${id}`);
		return { Id: id, State: { Status: 'running' }, ...info };
	});
	return { health, profiles };
}

const profileLabel = (profile?: string) => (port: number) => ({
	...labelsFor(port), ...mcpLabels, 'privos.env.secret-keys': '[]',
	...(profile ? { 'privos.securityProfile': profile } : {}),
});

const reconfigureReq = (port: number, extra: Record<string, unknown>) => ({
	workspaceId: 'workspace-1', appId: 'cluster-app-1', image: 'registry.example/app', digest,
	port, envVars: {}, mcpV3Binding: mcpBinding, runtimeResourceInventoryHash: 'i'.repeat(43), ...extra,
}) as any;

test('install with the securityProfile key absent creates a container with no profile', async (t) => {
	const { health, profiles } = await harness(t);
	await deployManagedApp({ workspaceId: 'workspace-1', image: 'registry.example/app', digest, port: health.port } as any);
	assert.deepEqual(profiles, [null]);
});

test('install applies a requested profile', async (t) => {
	const { health, profiles } = await harness(t);
	await deployManagedApp({ workspaceId: 'workspace-1', image: 'registry.example/app', digest, port: health.port, securityProfile: 'browser-sandbox' } as any);
	assert.deepEqual(profiles, ['browser-sandbox']);
});

test('reconfigure: an absent key keeps the label value', async (t) => {
	const { health, profiles } = await harness(t, profileLabel('browser-sandbox'));
	await reconfigureManagedAppV3(reconfigureReq(health.port, {}));
	assert.deepEqual(profiles, ['browser-sandbox']);
});

test('reconfigure: an absent key on a container without a profile stays none', async (t) => {
	const { health, profiles } = await harness(t, profileLabel());
	await reconfigureManagedAppV3(reconfigureReq(health.port, {}));
	assert.deepEqual(profiles, [null]);
});

test('reconfigure: an explicit null removes the profile', async (t) => {
	const { health, profiles } = await harness(t, profileLabel('browser-sandbox'));
	await reconfigureManagedAppV3(reconfigureReq(health.port, { securityProfile: null }));
	assert.deepEqual(profiles, [null]);
});

test('reconfigure: a value applies the profile', async (t) => {
	const { health, profiles } = await harness(t, profileLabel());
	await reconfigureManagedAppV3(reconfigureReq(health.port, { securityProfile: 'browser-sandbox' }));
	assert.deepEqual(profiles, ['browser-sandbox']);
});

const plainLabel = (profile?: string) => (port: number) => ({
	...labelsFor(port), ...(profile ? { 'privos.securityProfile': profile } : {}),
});

test('rolling redeploy: an absent key keeps the label value, null removes it, a value applies it', async (t) => {
	for (const [req, expected] of [
		[{}, 'browser-sandbox'],
		[{ securityProfile: null }, null],
		[{ securityProfile: 'browser-sandbox' }, 'browser-sandbox'],
	] as const) {
		const { profiles } = await harness(t, plainLabel('browser-sandbox'));
		await rollingRedeployContainer(containerId, { ...req, workspaceId: 'workspace-1' } as any, 'workspace-1');
		assert.deepEqual(profiles, [expected], JSON.stringify(req));
	}
	const { profiles } = await harness(t, plainLabel());
	await rollingRedeployContainer(containerId, { workspaceId: 'workspace-1' } as any, 'workspace-1');
	assert.deepEqual(profiles, [null]);
});
