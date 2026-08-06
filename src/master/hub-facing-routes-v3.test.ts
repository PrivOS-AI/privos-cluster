import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import { hubFacingRoutes } from './hub-facing-routes.js';

test('all Hub-facing v3 provisioning identity and install routes fail closed while the flag is off', async (t) => {
	const fastify = Fastify();
	t.after(() => fastify.close());
	let identityReads = 0;
	await fastify.register(hubFacingRoutes({
		auth: { verify: async (workspaceId: string) => ({ workspaceId }) } as any,
		deployment: {} as any,
		lifecycle: {} as any,
		repositories: {} as any,
		agentClient: {} as any,
		baseDomain: 'apps.example.com',
		mcpV2Enabled: false,
		mcpV3Enabled: false,
		mcpReconfigureEnabled: false,
		clusterMasterIdentity: {
			publicInfo: async () => {
				identityReads += 1;
				return {};
			},
		} as any,
		mcpReleaseAuthorityJwks: [],
	}));
	await fastify.ready();
	const headers = { authorization: 'Bearer test' };
	for (const url of [
		'/w/workspace-1/api/v1/mcp/v3/identity',
		'/w/workspace-1/api/v1/mcp/v3/cluster-identity',
	]) {
		const response = await fastify.inject({ method: 'GET', url, headers });
		assert.equal(response.statusCode, 404);
		assert.deepEqual(response.json(), { error: 'mcp_install_v3_disabled' });
	}
	const install = await fastify.inject({
		method: 'POST',
		url: '/w/workspace-1/api/v1/mcp/v3/apps/install',
		headers,
		payload: { deploymentGrantJws: 'signed' },
	});
	assert.equal(install.statusCode, 404);
	assert.equal(identityReads, 0);
});

test('v3 activation returns the exact persisted runtime-active instant on every retry', async (t) => {
	const fastify = Fastify();
	t.after(() => fastify.close());
	const establishedAt = new Date('2026-08-04T04:30:45.987Z');
	let activationCalls = 0;
	await fastify.register(hubFacingRoutes({
		auth: { verify: async (workspaceId: string) => ({ workspaceId }) } as any,
		deployment: {
			publicUrlFor: (subdomain: string) => `https://${subdomain}.apps.example.com`,
			activateMcpV3: async () => {
				activationCalls += 1;
				return {
					appId: 'cluster-app-1',
					subdomain: 'library-app',
					mcpRuntimeInstallationId: 'runtime-1',
					mcpInventoryAttestationEstablishedAt: establishedAt,
				};
			},
		} as any,
		lifecycle: {} as any,
		repositories: {} as any,
		agentClient: {} as any,
		baseDomain: 'apps.example.com',
		mcpV2Enabled: false,
		mcpV3Enabled: true,
		mcpReconfigureEnabled: true,
		clusterMasterIdentity: {} as any,
		mcpReleaseAuthorityJwks: [],
	}));
	await fastify.ready();
	const request = {
		method: 'POST' as const,
		url: '/w/workspace-1/api/v1/mcp/v3/apps/runtime-1/activate',
		headers: { authorization: 'Bearer test' },
		payload: {
			runtimeInventoryAttestation: {
				compact: 'header.payload.signature',
				artifactHash: 'A'.repeat(43),
			},
		},
	};
	const first = await fastify.inject(request);
	const retry = await fastify.inject(request);
	assert.equal(first.statusCode, 200);
	assert.deepEqual(first.json(), {
		state: 'RUNNING',
		clusterAppId: 'cluster-app-1',
		runtimeInstallationId: 'runtime-1',
		activatedAt: Math.floor(establishedAt.getTime() / 1000),
	});
	assert.deepEqual(retry.json(), first.json());
	assert.equal(activationCalls, 2);
});

test('v3 dispatch verifies parent/child affinity before Cluster selects a live HA replica', async (t) => {
	const fastify = Fastify();
	t.after(() => fastify.close());
	let verifierInput: any;
	const agentCalls: string[] = [];
	const app = {
		appId: 'cluster-app-1', workspaceId: 'workspace-1', kind: 'mcp-v3', state: 'RUNNING',
		mcpInventoryAttestationEstablishedAt: new Date(), mcpDeploymentId: 'deployment-1',
		mcpGenerationId: 'generation-1', mcpGenerationNumber: 1, mcpRuntimeInstallationId: 'runtime-1',
		manifestDigest: `sha256:${'f'.repeat(64)}`, mcpApprovalReceiptHash: 'b'.repeat(43),
		mcpAuthorizationEpoch: 7, resourceManifestHash: 'r'.repeat(43),
		runtimeResourceInventoryHash: 'i'.repeat(43), mcpAppId: 'mcp-app-1',
		replicas: [
			{ replicaId: '11111111-1111-4111-8111-111111111111', nodeId: 'node-1', containerId: 'container-1', state: 'running' },
			{ replicaId: '22222222-2222-4222-8222-222222222222', nodeId: 'node-2', containerId: 'container-2', state: 'running' },
		],
	};
	const nodes = [{ nodeId: 'node-1', status: 'ACTIVE' }, { nodeId: 'node-2', status: 'ACTIVE' }];
	await fastify.register(hubFacingRoutes({
		auth: { verify: async (workspaceId: string) => ({ workspaceId }) } as any,
		deployment: {} as any,
		lifecycle: {} as any,
		repositories: {
			apps: { findOne: async () => app },
			nodes: { find: () => ({ toArray: async () => nodes }) },
		} as any,
		agentClient: {
			request: async (_node: { nodeId: string }, _workspaceId: string, method: string, path: string, body?: unknown) => {
				agentCalls.push(`${method} ${path}`);
				if (path.endsWith('/status')) {
					return path.includes('container-1')
						? { status: 200, body: { state: 'running', healthStatus: 'unhealthy' } }
						: { status: 200, body: { state: 'running', healthStatus: 'healthy' } };
				}
				assert.equal((body as any).runtimeResourceInventoryHash, 'i'.repeat(43));
				assert.equal((body as any).replicaId, undefined);
				assert.deepEqual((body as any).callerCredential, {
					token: 'credential.sentinel.signature',
					assertedUserId: 'user-1',
				});
				return { status: 200, body: { ok: true, selected: 'container-2' } };
			},
		} as any,
		baseDomain: 'apps.example.com',
		mcpSecurity: {
			consumeDispatchAssertionV3: async (input: unknown) => { verifierInput = input; return {}; },
		} as any,
		mcpV2Enabled: false,
		mcpV3Enabled: true,
		mcpReconfigureEnabled: true,
		clusterMasterIdentity: {} as any,
		mcpReleaseAuthorityJwks: [],
	}));
	await fastify.ready();
	const response = await fastify.inject({
		method: 'POST',
		url: '/w/workspace-1/api/v1/apps/cluster-app-1/dispatch',
		headers: { authorization: 'Bearer test' },
		payload: {
			assertion: 'signed',
			rpc: { jsonrpc: '2.0', method: 'tools/call', id: 1 },
			authorizationContext: 'room',
			runtimeInstallationId: 'runtime-1',
			authorizationBindingId: 'binding-1',
			callerCredential: {
				token: 'credential.sentinel.signature',
				assertedUserId: 'user-1',
			},
		},
	});
	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.json(), { ok: true, selected: 'container-2' });
	assert.equal(verifierInput.expected.replicaId, undefined);
	assert.equal(verifierInput.authorization.authorizationBindingId, 'binding-1');
	assert.equal(verifierInput.authorization.callerCredential, undefined);
	assert.deepEqual(agentCalls, [
		'GET /api/v1/apps/container-1/status',
		'GET /api/v1/apps/container-2/status',
		'POST /api/v1/apps/container-2/dispatch',
	]);
});
