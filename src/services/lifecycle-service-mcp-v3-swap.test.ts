/**
 * Empirical proof for the recovery path `createAndStartRedeployedContainer`
 * gives an MCP v3 upgrade: a forward swap that fails AFTER the broker binding
 * is written must not leave an orphaned container behind, and a second
 * (recovery) attempt for the same replica must actually be able to register —
 * not throw `persisted_mcp_v3_broker_binding_conflict` against what the failed
 * forward attempt already wrote.
 *
 * This exercises the REAL `McpBrokerManager` (rooted at a throwaway temp
 * directory) so the assertion is against the actual persistFinalizedV3
 * write-once behaviour, not a stand-in for it. Only the Docker-touching
 * `containerManager` methods are mocked — no real Docker daemon is required.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// MCP_BROKER_ROOT must be set before config.js first loads (it reads env at
// import time), so every import that reaches it is deferred with a dynamic
// import until after this line runs.
const brokerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-broker-test-'));
process.env.MCP_BROKER_ROOT = brokerRoot;

const { containerManager, docker } = await import('../docker/index.js');
const { mcpBrokerManager } = await import('./mcp-broker.js');
const { createAndStartRedeployedContainer, redeployContainer } = await import('./lifecycle-service.js');

function startHealthServer(): Promise<{ port: number; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const server = http.createServer((_req, res) => {
			res.writeHead(200);
			res.end('ok');
		});
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			resolve({ port, close: () => new Promise((r) => server.close(() => r(undefined))) });
		});
	});
}

function inspectFixture(dockerContainerId: string, containerId: string, imageDigest: string): any {
	return {
		Id: dockerContainerId,
		Name: `/${dockerContainerId}`,
		Created: new Date().toISOString(),
		State: { Status: 'running', StartedAt: new Date().toISOString(), FinishedAt: '0001-01-01T00:00:00Z' },
		Config: {
			Image: 'registry.example/app:latest',
			Env: [],
			Labels: {
				'privos.managed': 'true',
				'privos.id': containerId,
				'privos.app-id': 'cluster-app-1',
				'privos.workspace': 'workspace-1',
				'privos.image': 'registry.example/app',
				'privos.tag': 'latest',
				'privos.image.digest': imageDigest,
				'privos.port': '3001',
				'privos.resources': JSON.stringify({ memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 }),
				'privos.env': '{}',
				'privos.subdomain': '',
				'privos.domain': '',
				'privos.created-at': new Date().toISOString(),
				'privos.health.path': '/health',
				'privos.health.max-fails': '3',
				'privos.health.restart': 'true',
			},
		},
		NetworkSettings: { Ports: {} },
		Mounts: [],
	};
}

test('a forward swap that fails after the broker binding is written is recovered by a clean second attempt', async (t) => {
	const health = await startHealthServer();
	t.after(async () => {
		await health.close();
		await mcpBrokerManager.closeAll();
		await fs.rm(brokerRoot, { recursive: true, force: true });
	});

	const replicaId = '11111111-1111-4111-8111-111111111111';
	const containerId = '22222222-2222-4222-8222-222222222222';
	const targetDigest = `sha256:${'f'.repeat(64)}`;
	const previousDigest = `sha256:${'e'.repeat(64)}`;
	const hubPublicJwk = { kty: 'EC', crv: 'P-256', x: 'x-coordinate', y: 'y-coordinate' } as any;

	const targetBinding = {
		protocolVersion: 3 as const,
		clusterId: 'cluster-1', nodeId: 'node-1', workspaceId: 'workspace-1',
		deploymentId: 'deployment-1', generationId: 'generation-1', generationNumber: 1,
		runtimeInstallationId: 'runtime-1', mcpAppId: 'mcp-app-1', replicaId, containerId,
		imageDigest: targetDigest, manifestDigest: targetDigest,
		approvalReceiptHash: 'b'.repeat(43), authorizationEpoch: 7, deploymentGrantHash: 'g'.repeat(43),
		resourceManifestHash: 'r'.repeat(43),
		hubOrigin: 'https://hub.example.com', hubKid: 'kid-1', hubPublicJwk,
	};
	const previousBinding = { ...targetBinding, imageDigest: previousDigest, manifestDigest: previousDigest };

	let createAppContainerCalls = 0;
	const createCalls: string[] = [];
	const removedContainerIds: string[] = [];

	t.mock.method(containerManager, 'createAppContainer', async () => {
		createAppContainerCalls += 1;
		const dockerContainerId = createAppContainerCalls === 1 ? 'docker-forward' : 'docker-recovery';
		createCalls.push(dockerContainerId);
		return { containerId: dockerContainerId, containerName: `name-${dockerContainerId}`, hostPort: 0 };
	});
	t.mock.method(containerManager, 'startContainer', async () => undefined);
	t.mock.method(containerManager, 'stopContainer', async () => undefined);
	t.mock.method(containerManager, 'removeContainer', async (id: string) => {
		removedContainerIds.push(id);
	});
	t.mock.method(containerManager, 'getContainerIp', async (dockerContainerId: string) => {
		// Simulates the single most likely real failure: the new image starts
		// then immediately exits, so it never gets an app-network address.
		if (dockerContainerId === 'docker-forward') throw new Error('no such container');
		return '127.0.0.1';
	});
	t.mock.method(containerManager, 'listContainers', async () => [{ Id: 'docker-recovery' }]);
	t.mock.method(containerManager, 'inspectContainer', async (dockerContainerId: string) =>
		inspectFixture(dockerContainerId, containerId, previousDigest));

	const baseParams = {
		containerId,
		appId: 'cluster-app-1',
		image: 'registry.example/app',
		tag: 'latest',
		workspaceId: 'workspace-1',
		listingId: undefined,
		versionDigest: undefined,
		port: health.port,
		resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 },
		envVars: {},
		mounts: [],
		subdomain: null,
		baseDomain: null,
		createdAt: Date.now(),
	};

	await assert.rejects(createAndStartRedeployedContainer({
		...baseParams,
		containerName: 'forward-name',
		digest: targetDigest,
		mcp: {
			binding: targetBinding,
			runtimeResourceInventoryHash: 'i'.repeat(43),
			platformEnvVars: { PRIVOS_PUBLIC_URL: 'https://library-app.apps.example.com', PRIVOS_ACCESS_MODE: 'managed-runtime' },
			secretEnvKeys: [],
		},
	}));

	// C3: the orphaned forward container must be cleaned up before any retry —
	// not left running (or even just left existing) alongside whatever the
	// next attempt creates.
	assert.deepEqual(removedContainerIds, ['docker-forward']);

	// C2: without the fix, this second attempt's register() throws
	// persisted_mcp_v3_broker_binding_conflict, because binding-v3.json still
	// held the TARGET digest the failed forward attempt wrote — the D4 revert
	// would be unreachable for exactly this, the single most likely real
	// failure (image starts then exits).
	const recovered = await createAndStartRedeployedContainer({
		...baseParams,
		containerName: 'recovery-name',
		digest: previousDigest,
		mcp: {
			binding: previousBinding,
			runtimeResourceInventoryHash: 'i'.repeat(43),
			platformEnvVars: { PRIVOS_PUBLIC_URL: 'https://library-app.apps.example.com', PRIVOS_ACCESS_MODE: 'managed-runtime' },
			secretEnvKeys: [],
		},
	});

	assert.equal(recovered.dockerContainerId, 'docker-recovery');
	assert.deepEqual(createCalls, ['docker-forward', 'docker-recovery']);
});

test('a new image that starts, gets an IP, then exits is refused rather than silently reported UPGRADED', async (t) => {
	const health = await startHealthServer();
	t.after(async () => {
		await health.close();
		await mcpBrokerManager.closeAll();
		await fs.rm(brokerRoot, { recursive: true, force: true });
	});

	const replicaId = '33333333-3333-4333-8333-333333333333';
	const containerId = '44444444-4444-4444-8444-444444444444';
	const targetDigest = `sha256:${'a'.repeat(64)}`;
	const previousDigest = `sha256:${'c'.repeat(64)}`;
	const hubPublicJwk = { kty: 'EC', crv: 'P-256', x: 'x-coordinate', y: 'y-coordinate' } as any;
	const bindingCommon = {
		protocolVersion: 3 as const,
		clusterId: 'cluster-1', nodeId: 'node-1', workspaceId: 'workspace-1',
		deploymentId: 'deployment-1', generationId: 'generation-1', generationNumber: 1,
		runtimeInstallationId: 'runtime-1', mcpAppId: 'mcp-app-1', replicaId, containerId,
		approvalReceiptHash: 'b'.repeat(43), authorizationEpoch: 7, deploymentGrantHash: 'g'.repeat(43),
		resourceManifestHash: 'r'.repeat(43),
		hubOrigin: 'https://hub.example.com', hubKid: 'kid-1', hubPublicJwk,
	};
	const targetBinding = { ...bindingCommon, imageDigest: targetDigest, manifestDigest: targetDigest };
	const previousBinding = { ...bindingCommon, imageDigest: previousDigest, manifestDigest: previousDigest };

	let createAppContainerCalls = 0;
	const removedContainerIds: string[] = [];

	t.mock.method(containerManager, 'createAppContainer', async () => {
		createAppContainerCalls += 1;
		const dockerContainerId = createAppContainerCalls === 1 ? 'docker-crashed' : 'docker-good';
		return { containerId: dockerContainerId, containerName: `name-${dockerContainerId}`, hostPort: 0 };
	});
	t.mock.method(containerManager, 'startContainer', async () => undefined);
	t.mock.method(containerManager, 'stopContainer', async () => undefined);
	t.mock.method(containerManager, 'removeContainer', async (id: string) => {
		removedContainerIds.push(id);
	});
	// The crashed container DID get an app-network address briefly (it started
	// fine) — getInternalUrl succeeds, and the health endpoint is reachable
	// (this test's tiny server answers 200 for anything), so waitForHealthy
	// would ALSO report healthy. Only the post-start Docker process state
	// reveals it actually exited — the exact scenario D4's healthcheck
	// exclusion cannot catch on its own.
	t.mock.method(containerManager, 'getContainerIp', async () => '127.0.0.1');
	t.mock.method(containerManager, 'listContainers', async () => [{ Id: 'docker-good' }]);
	t.mock.method(containerManager, 'inspectContainer', async (dockerContainerId: string) => ({
		...inspectFixture(dockerContainerId, containerId, previousDigest),
		State: {
			Status: dockerContainerId === 'docker-crashed' ? 'exited' : 'running',
			StartedAt: new Date().toISOString(),
			FinishedAt: dockerContainerId === 'docker-crashed' ? new Date().toISOString() : '0001-01-01T00:00:00Z',
		},
	}));

	const baseParams = {
		containerId,
		appId: 'cluster-app-1',
		image: 'registry.example/app',
		tag: 'latest',
		workspaceId: 'workspace-1',
		listingId: undefined,
		versionDigest: undefined,
		port: health.port,
		resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 },
		envVars: {},
		mounts: [],
		subdomain: null,
		baseDomain: null,
		createdAt: Date.now(),
	};

	await assert.rejects(
		createAndStartRedeployedContainer({
			...baseParams,
			containerName: 'forward-name',
			digest: targetDigest,
			mcp: {
				binding: targetBinding,
				runtimeResourceInventoryHash: 'i'.repeat(43),
				platformEnvVars: { PRIVOS_PUBLIC_URL: 'https://library-app.apps.example.com', PRIVOS_ACCESS_MODE: 'managed-runtime' },
				secretEnvKeys: [],
			},
		}),
		/exited after start/,
	);
	assert.deepEqual(removedContainerIds, ['docker-crashed'], 'the exited container must be cleaned up, not left behind as a false UPGRADED');

	const recovered = await createAndStartRedeployedContainer({
		...baseParams,
		containerName: 'recovery-name',
		digest: previousDigest,
		mcp: {
			binding: previousBinding,
			runtimeResourceInventoryHash: 'i'.repeat(43),
			platformEnvVars: { PRIVOS_PUBLIC_URL: 'https://library-app.apps.example.com', PRIVOS_ACCESS_MODE: 'managed-runtime' },
			secretEnvKeys: [],
		},
	});
	assert.equal(recovered.dockerContainerId, 'docker-good');
});

/**
 * H4: the recovery path must never depend on being able to pull the previous
 * image AFTER a failure — it must already be resident because it was pulled
 * proactively, before the old container was touched at all. This test drives
 * `redeployContainer` (the full function, not just the create-and-start
 * helper) with a tiny in-memory Docker registry so container removal/creation
 * actually changes what subsequent inspect/list calls see.
 */
test('redeployContainer pre-pulls the previous image before the old container is touched', async (t) => {
	const health = await startHealthServer();
	t.after(async () => {
		await health.close();
		await mcpBrokerManager.closeAll();
		await fs.rm(brokerRoot, { recursive: true, force: true });
	});

	const replicaId = '55555555-5555-4555-8555-555555555555';
	const containerId = '66666666-6666-4666-8666-666666666666';
	const targetDigest = `sha256:${'1'.repeat(64)}`;
	const previousDigest = `sha256:${'2'.repeat(64)}`;
	const oldDockerId = 'docker-old';
	const newDockerId = 'docker-new';

	const mcpLabels = {
		'privos.mcp.schema': '3',
		'privos.mcp.cluster': 'cluster-1',
		'privos.mcp.node': 'node-1',
		'privos.mcp.workspace': 'workspace-1',
		'privos.mcp.deployment': 'deployment-1',
		'privos.mcp.generation': 'generation-1',
		'privos.mcp.generation-number': '1',
		'privos.mcp.runtime-installation': 'runtime-1',
		'privos.mcp.app': 'mcp-app-1',
		'privos.mcp.replica': replicaId,
		'privos.mcp.approval-receipt': 'b'.repeat(43),
		'privos.mcp.authorization-epoch': '7',
		'privos.mcp.deployment-grant-hash': 'g'.repeat(43),
		'privos.mcp.resource-manifest-hash': 'r'.repeat(43),
		'privos.mcp.hub-origin': 'https://hub.example.com',
		'privos.mcp.hub-kid': 'kid-1',
		'privos.mcp.hub-jwk': JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x-coordinate', y: 'y-coordinate' }),
	};

	const oldInspect = inspectFixture(oldDockerId, containerId, previousDigest);
	Object.assign(oldInspect.Config.Labels, mcpLabels, {
		'privos.mcp.image.digest': previousDigest,
		'privos.mcp.manifest.digest': previousDigest,
		'privos.env.secret-keys': '[]',
		// Must match the tiny local health server below, or waitForHealthy spends
		// its full 30s timeout probing a port nothing listens on.
		'privos.port': String(health.port),
	});

	// A tiny in-memory Docker so removal/creation actually changes what
	// subsequent inspect/list calls see — needed to drive the FULL
	// redeployContainer function (getContainerOr404, resource budget,
	// mount discovery, MCP affinity, and the final dockerState.getById all
	// call inspectContainer/listContainers independently).
	const registry = new Map<string, any>([[oldDockerId, oldInspect]]);
	const calls: string[] = [];

	t.mock.method(docker, 'info', async () => ({ MemTotal: 8 * 1024 * 1024 * 1024, NCPU: 4 }));
	t.mock.method(containerManager, 'pullImage', async (_image: string, _tag: string, digest?: string) => {
		calls.push(`pull:${digest}`);
	});
	t.mock.method(containerManager, 'stopContainer', async (dockerId: string) => {
		calls.push(`stop:${dockerId}`);
	});
	t.mock.method(containerManager, 'removeContainer', async (dockerId: string) => {
		calls.push(`remove:${dockerId}`);
		registry.delete(dockerId);
	});
	t.mock.method(containerManager, 'createAppContainer', async () => {
		calls.push('create');
		const newInspect = inspectFixture(newDockerId, containerId, targetDigest);
		Object.assign(newInspect.Config.Labels, mcpLabels, {
			'privos.mcp.image.digest': targetDigest,
			'privos.mcp.manifest.digest': targetDigest,
			'privos.env.secret-keys': '[]',
			'privos.port': String(health.port),
		});
		registry.set(newDockerId, newInspect);
		return { containerId: newDockerId, containerName: 'new-name', hostPort: 0 };
	});
	t.mock.method(containerManager, 'startContainer', async () => {
		calls.push('start');
	});
	t.mock.method(containerManager, 'getContainerIp', async () => '127.0.0.1');
	t.mock.method(containerManager, 'listContainers', async () => [...registry.keys()].map((Id) => ({ Id })));
	t.mock.method(containerManager, 'inspectContainer', async (dockerId: string) => {
		const info = registry.get(dockerId);
		if (!info) throw new Error(`no such container: ${dockerId}`);
		return info;
	});

	const targetBinding = {
		clusterId: 'cluster-1', nodeId: 'node-1', workspaceId: 'workspace-1',
		deploymentId: 'deployment-1', generationId: 'generation-1', generationNumber: 1,
		runtimeInstallationId: 'runtime-1', mcpAppId: 'mcp-app-1', replicaId, containerId,
		imageDigest: targetDigest, manifestDigest: targetDigest,
		approvalReceiptHash: 'b'.repeat(43), authorizationEpoch: 7, deploymentGrantHash: 'g'.repeat(43),
		resourceManifestHash: 'r'.repeat(43),
	};

	const result = await redeployContainer(containerId, {
		workspaceId: 'workspace-1',
		digest: targetDigest,
		mcpV3Binding: targetBinding as any,
		runtimeResourceInventoryHash: 'i'.repeat(43),
		envVars: {},
		secretEnvKeys: [],
		platformEnvVars: { PRIVOS_PUBLIC_URL: 'https://library-app.apps.example.com', PRIVOS_ACCESS_MODE: 'managed-runtime' },
	}, 'workspace-1');

	assert.equal(result.dockerContainerId, newDockerId);
	// The previous digest must be pulled BEFORE the old container is stopped or
	// removed — not only reactively, inside a failure handler.
	const pullTarget = calls.indexOf(`pull:${targetDigest}`);
	const pullPrevious = calls.indexOf(`pull:${previousDigest}`);
	const stopOld = calls.indexOf(`stop:${oldDockerId}`);
	const removeOld = calls.indexOf(`remove:${oldDockerId}`);
	assert.notEqual(pullPrevious, -1, 'the previous digest must be pulled at all');
	assert.ok(pullTarget < pullPrevious, 'target pulled before previous');
	assert.ok(pullPrevious < stopOld, 'previous image pulled before the old container is stopped');
	assert.ok(pullPrevious < removeOld, 'previous image pulled before the old container is removed');
});
