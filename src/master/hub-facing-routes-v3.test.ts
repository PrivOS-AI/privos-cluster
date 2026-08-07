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
		mcpUpgradeEnabled: false,
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
		mcpUpgradeEnabled: true,
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
		mcpUpgradeEnabled: true,
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
		},
	});
	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.json(), { ok: true, selected: 'container-2' });
	assert.equal(verifierInput.expected.replicaId, undefined);
	assert.equal(verifierInput.authorization.authorizationBindingId, 'binding-1');
	assert.deepEqual(agentCalls, [
		'GET /api/v1/apps/container-1/status',
		'GET /api/v1/apps/container-2/status',
		'POST /api/v1/apps/container-2/dispatch',
	]);
});

test('v3 upgrade is fail-closed while its kill switch is off', async (t) => {
	const fastify = Fastify();
	t.after(() => fastify.close());
	let securityCalls = 0;
	await fastify.register(hubFacingRoutes({
		auth: { verify: async (workspaceId: string) => ({ workspaceId }) } as any,
		deployment: {} as any,
		lifecycle: {} as any,
		repositories: {} as any,
		agentClient: {} as any,
		baseDomain: 'apps.example.com',
		mcpSecurity: { consumeUpgradeCommandV3: async () => { securityCalls += 1; return {} as any; } } as any,
		mcpV2Enabled: false,
		mcpV3Enabled: true,
		mcpReconfigureEnabled: true,
		mcpUpgradeEnabled: false,
		clusterMasterIdentity: {} as any,
		mcpReleaseAuthorityJwks: [],
	}));
	await fastify.ready();
	const response = await fastify.inject({
		method: 'POST',
		url: '/w/workspace-1/api/v1/mcp/v3/apps/runtime-1/upgrade',
		headers: { authorization: 'Bearer test' },
		payload: {
			upgradeCommandJws: 'signed',
			issuer: 'urn:privos:hub:deployment-1',
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 1,
			clusterAppId: 'cluster-app-1',
			mcpAppId: 'mcp-app-1',
			resourceManifestHash: 'r'.repeat(43),
			runtimeResourceInventoryHash: 'i'.repeat(43),
		},
	});
	assert.equal(response.statusCode, 404);
	assert.deepEqual(response.json(), { error: 'mcp_upgrade_v3_disabled' });
	assert.equal(securityCalls, 0);
});

test('v3 upgrade refuses a new image whose manifest label does not reduce to the pinned digest, before the swap is ever attempted', async (t) => {
	const fastify = Fastify();
	t.after(() => fastify.close());
	let upgradeCalls = 0;
	const command = {
		operationId: '33333333-3333-4333-8333-333333333333',
		clusterId: 'cluster-1',
		workspaceId: 'workspace-1',
		deploymentId: 'deployment-1',
		generationId: 'generation-1',
		generationNumber: 1,
		revision: 1,
		runtimeInstallationId: 'runtime-1',
		clusterAppId: 'cluster-app-1',
		mcpAppId: 'mcp-app-1',
		targetManifestDigest: `sha256:${'f'.repeat(64)}`,
		targetImageDigest: `sha256:${'f'.repeat(64)}`,
		previousManifestDigest: `sha256:${'e'.repeat(64)}`,
		previousImageDigest: `sha256:${'e'.repeat(64)}`,
		resourceManifestHash: 'r'.repeat(43),
		runtimeResourceInventoryHash: 'i'.repeat(43),
		authorizationEpoch: 7,
		upgradeEpoch: 1,
	};
	await fastify.register(hubFacingRoutes({
		auth: { verify: async (workspaceId: string) => ({ workspaceId }) } as any,
		deployment: { upgradeMcpV3: async () => { upgradeCalls += 1; throw new Error('must not be reached'); } } as any,
		lifecycle: {} as any,
		repositories: {
			apps: { findOne: async () => ({ image: 'registry.example/app', workspaceId: 'workspace-1' }) },
			nodes: { findOne: async () => ({ nodeId: 'node-1' }) },
		} as any,
		agentClient: {
			request: async () => ({ status: 200, body: { imageDigest: `sha256:${'f'.repeat(64)}`, manifestDigest: `sha256:${'0'.repeat(64)}` } }),
		} as any,
		baseDomain: 'apps.example.com',
		mcpSecurity: { consumeUpgradeCommandV3: async () => command as any } as any,
		mcpV2Enabled: false,
		mcpV3Enabled: true,
		mcpReconfigureEnabled: true,
		mcpUpgradeEnabled: true,
		clusterMasterIdentity: {
			signUpgradeAcknowledgement: async (input: any) => {
				// B3: a refusal that never touched a container is REFUSED, never
				// FAILED — the Hub must be able to return the installation to
				// ACTIVE and treat this as a normal, retryable refusal.
				assert.equal(input.state, 'REFUSED');
				return { compact: 'header.payload.signature', artifactHash: 'A'.repeat(43), kid: 'kid-1' };
			},
		} as any,
		mcpReleaseAuthorityJwks: [],
	}));
	await fastify.ready();
	const response = await fastify.inject({
		method: 'POST',
		url: '/w/workspace-1/api/v1/mcp/v3/apps/runtime-1/upgrade',
		headers: { authorization: 'Bearer test' },
		payload: {
			upgradeCommandJws: 'signed',
			issuer: 'urn:privos:hub:deployment-1',
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 1,
			clusterAppId: 'cluster-app-1',
			mcpAppId: 'mcp-app-1',
			resourceManifestHash: 'r'.repeat(43),
			runtimeResourceInventoryHash: 'i'.repeat(43),
		},
	});
	assert.equal(response.statusCode, 409);
	const json = response.json();
	assert.equal(json.state, 'REFUSED');
	assert.equal(json.error, 'inspected_artifact_binding_mismatch');
	assert.ok(json.acknowledgement, 'a 409 refusal must carry a signed acknowledgement, not a bare {error}');
	assert.equal(upgradeCalls, 0, 'a manifest label mismatch must never reach the swap');
});

test('a successful v3 upgrade verifies the label, delegates the swap, and returns a signed UPGRADED acknowledgement', async (t) => {
	const fastify = Fastify();
	t.after(() => fastify.close());
	const callOrder: string[] = [];
	const command = {
		operationId: '33333333-3333-4333-8333-333333333333',
		clusterId: 'cluster-1',
		workspaceId: 'workspace-1',
		deploymentId: 'deployment-1',
		generationId: 'generation-1',
		generationNumber: 1,
		revision: 1,
		runtimeInstallationId: 'runtime-1',
		clusterAppId: 'cluster-app-1',
		mcpAppId: 'mcp-app-1',
		targetManifestDigest: `sha256:${'f'.repeat(64)}`,
		targetImageDigest: `sha256:${'f'.repeat(64)}`,
		previousManifestDigest: `sha256:${'e'.repeat(64)}`,
		previousImageDigest: `sha256:${'e'.repeat(64)}`,
		resourceManifestHash: 'r'.repeat(43),
		runtimeResourceInventoryHash: 'i'.repeat(43),
		authorizationEpoch: 7,
		upgradeEpoch: 1,
	};
	const upgradedApp = {
		appId: 'cluster-app-1',
		subdomain: 'library-app',
		manifestDigest: command.targetManifestDigest,
		imageDigest: command.targetImageDigest,
		updatedAt: new Date('2026-08-07T00:00:00.000Z'),
	};
	await fastify.register(hubFacingRoutes({
		auth: { verify: async (workspaceId: string) => ({ workspaceId }) } as any,
		deployment: {
			publicUrlFor: (subdomain: string) => `https://${subdomain}.apps.example.com`,
			upgradeMcpV3: async () => {
				callOrder.push('upgradeMcpV3');
				return { app: upgradedApp, swapStrategy: 'STOP_THEN_CREATE' };
			},
		} as any,
		lifecycle: {} as any,
		repositories: {
			apps: { findOne: async () => ({ image: 'registry.example/app', workspaceId: 'workspace-1' }) },
			nodes: { findOne: async () => ({ nodeId: 'node-1' }) },
		} as any,
		agentClient: {
			request: async () => {
				callOrder.push('imageInspect');
				return { status: 200, body: { imageDigest: command.targetImageDigest, manifestDigest: command.targetManifestDigest } };
			},
		} as any,
		baseDomain: 'apps.example.com',
		mcpSecurity: {
			consumeUpgradeCommandV3: async () => {
				callOrder.push('consumeUpgradeCommandV3');
				return command as any;
			},
		} as any,
		mcpV2Enabled: false,
		mcpV3Enabled: true,
		mcpReconfigureEnabled: true,
		mcpUpgradeEnabled: true,
		clusterMasterIdentity: {
			signUpgradeAcknowledgement: async (input: any) => {
				callOrder.push('signUpgradeAcknowledgement');
				assert.equal(input.state, 'UPGRADED');
				assert.equal(input.swapStrategy, 'STOP_THEN_CREATE');
				assert.equal(input.runningManifestDigest, command.targetManifestDigest);
				return { compact: 'header.payload.signature', artifactHash: 'A'.repeat(43), kid: 'kid-1' };
			},
		} as any,
		mcpReleaseAuthorityJwks: [],
	}));
	await fastify.ready();
	const response = await fastify.inject({
		method: 'POST',
		url: '/w/workspace-1/api/v1/mcp/v3/apps/runtime-1/upgrade',
		headers: { authorization: 'Bearer test' },
		payload: {
			upgradeCommandJws: 'signed',
			issuer: 'urn:privos:hub:deployment-1',
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 1,
			clusterAppId: 'cluster-app-1',
			mcpAppId: 'mcp-app-1',
			resourceManifestHash: 'r'.repeat(43),
			runtimeResourceInventoryHash: 'i'.repeat(43),
		},
	});
	assert.equal(response.statusCode, 200);
	const json = response.json();
	assert.equal(json.state, 'UPGRADED');
	assert.equal(json.clusterAppId, 'cluster-app-1');
	assert.equal(json.publicUrl, 'https://library-app.apps.example.com');
	assert.deepEqual(callOrder, ['consumeUpgradeCommandV3', 'imageInspect', 'upgradeMcpV3', 'signUpgradeAcknowledgement']);
});

test('a FAILED v3 upgrade acknowledgement re-reads the app instead of trusting the pre-call snapshot', async (t) => {
	const fastify = Fastify();
	t.after(() => fastify.close());
	const command = {
		operationId: '33333333-3333-4333-8333-333333333333',
		clusterId: 'cluster-1',
		workspaceId: 'workspace-1',
		deploymentId: 'deployment-1',
		generationId: 'generation-1',
		generationNumber: 1,
		revision: 2,
		runtimeInstallationId: 'runtime-1',
		clusterAppId: 'cluster-app-1',
		mcpAppId: 'mcp-app-1',
		targetManifestDigest: `sha256:${'f'.repeat(64)}`,
		targetImageDigest: `sha256:${'f'.repeat(64)}`,
		previousManifestDigest: `sha256:${'e'.repeat(64)}`,
		previousImageDigest: `sha256:${'e'.repeat(64)}`,
		resourceManifestHash: 'r'.repeat(43),
		runtimeResourceInventoryHash: 'i'.repeat(43),
		authorizationEpoch: 7,
		upgradeEpoch: 2,
	};
	// The pre-call snapshot (what the route reads BEFORE calling upgradeMcpV3)
	// claims an already-stale digest; the "actually current" row (what a
	// concurrent HA-replica revert left behind) is different. The signed ack
	// must reflect the SECOND read, not the first.
	let findOneCalls = 0;
	await fastify.register(hubFacingRoutes({
		auth: { verify: async (workspaceId: string) => ({ workspaceId }) } as any,
		deployment: {
			upgradeMcpV3: async () => {
				// code identifies this as a swap that actually reached the agent
				// (not a pre-swap refusal) — see B3: only this tag makes the route
				// sign ROLLED_BACK/FAILED instead of REFUSED.
				throw Object.assign(new Error('agent MCP v3 upgrade failed'), {
					code: 'MCP_V3_UPGRADE_SWAP_FAILED',
					rolledBack: true,
				});
			},
		} as any,
		lifecycle: {} as any,
		repositories: {
			apps: {
				findOne: async () => {
					findOneCalls += 1;
					return findOneCalls === 1
						? { image: 'registry.example/app', workspaceId: 'workspace-1', manifestDigest: `sha256:${'0'.repeat(64)}`, imageDigest: `sha256:${'0'.repeat(64)}` }
						: { image: 'registry.example/app', workspaceId: 'workspace-1', manifestDigest: command.previousManifestDigest, imageDigest: command.previousImageDigest, mcpLastSwapStrategy: 'STOP_THEN_CREATE' };
				},
			},
			nodes: { findOne: async () => ({ nodeId: 'node-1' }) },
		} as any,
		agentClient: {
			request: async () => ({ status: 200, body: { imageDigest: command.targetImageDigest, manifestDigest: command.targetManifestDigest } }),
		} as any,
		baseDomain: 'apps.example.com',
		mcpSecurity: { consumeUpgradeCommandV3: async () => command as any } as any,
		mcpV2Enabled: false,
		mcpV3Enabled: true,
		mcpReconfigureEnabled: true,
		mcpUpgradeEnabled: true,
		clusterMasterIdentity: {
			signUpgradeAcknowledgement: async (input: any) => {
				assert.equal(input.state, 'ROLLED_BACK');
				assert.equal(input.runningManifestDigest, command.previousManifestDigest, 'must use the re-read digest, not the stale pre-call one');
				assert.equal(input.runningImageDigest, command.previousImageDigest);
				return { compact: 'header.payload.signature', artifactHash: 'A'.repeat(43), kid: 'kid-1' };
			},
		} as any,
		mcpReleaseAuthorityJwks: [],
	}));
	await fastify.ready();
	const response = await fastify.inject({
		method: 'POST',
		url: '/w/workspace-1/api/v1/mcp/v3/apps/runtime-1/upgrade',
		headers: { authorization: 'Bearer test' },
		payload: {
			upgradeCommandJws: 'signed',
			issuer: 'urn:privos:hub:deployment-1',
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 1,
			clusterAppId: 'cluster-app-1',
			mcpAppId: 'mcp-app-1',
			resourceManifestHash: 'r'.repeat(43),
			runtimeResourceInventoryHash: 'i'.repeat(43),
		},
	});
	assert.equal(response.statusCode, 409);
	assert.equal(response.json().state, 'ROLLED_BACK');
	assert.equal(findOneCalls, 2, 'the app must be read once before the swap and once more before signing the failure ack');
});

test('B3: a pre-swap refusal that touched no container is acked REFUSED, never FAILED — the Hub must be able to retry it', async (t) => {
	const fastify = Fastify();
	t.after(() => fastify.close());
	const command = {
		operationId: '33333333-3333-4333-8333-333333333333',
		clusterId: 'cluster-1',
		workspaceId: 'workspace-1',
		deploymentId: 'deployment-1',
		generationId: 'generation-1',
		generationNumber: 1,
		revision: 3,
		runtimeInstallationId: 'runtime-1',
		clusterAppId: 'cluster-app-1',
		mcpAppId: 'mcp-app-1',
		targetManifestDigest: `sha256:${'f'.repeat(64)}`,
		targetImageDigest: `sha256:${'f'.repeat(64)}`,
		previousManifestDigest: `sha256:${'e'.repeat(64)}`,
		previousImageDigest: `sha256:${'e'.repeat(64)}`,
		resourceManifestHash: 'r'.repeat(43),
		runtimeResourceInventoryHash: 'i'.repeat(43),
		authorizationEpoch: 7,
		upgradeEpoch: 3,
	};
	await fastify.register(hubFacingRoutes({
		auth: { verify: async (workspaceId: string) => ({ workspaceId }) } as any,
		deployment: {
			upgradeMcpV3: async () => {
				// Exactly what DeploymentService.upgradeMcpV3 throws for e.g. a node
				// bouncing mid-request (app.state !== 'RUNNING') or a stale
				// authorizationEpoch — thrown BEFORE the try/catch that wraps the
				// per-replica loop, so it carries no MCP_V3_UPGRADE_SWAP_FAILED /
				// MCP_V3_UPGRADE_PERSISTENCE_FAILED code and no `rolledBack` flag.
				const error = new Error('state_QUARANTINED');
				(error as any).code = 'RUNTIME_NOT_UPGRADABLE';
				throw error;
			},
		} as any,
		lifecycle: {} as any,
		repositories: {
			apps: {
				findOne: async () => ({
					image: 'registry.example/app', workspaceId: 'workspace-1',
					manifestDigest: command.previousManifestDigest, imageDigest: command.previousImageDigest,
					mcpLastSwapStrategy: 'STOP_THEN_CREATE',
				}),
			},
			nodes: { findOne: async () => ({ nodeId: 'node-1' }) },
		} as any,
		agentClient: {
			request: async () => ({ status: 200, body: { imageDigest: command.targetImageDigest, manifestDigest: command.targetManifestDigest } }),
		} as any,
		baseDomain: 'apps.example.com',
		mcpSecurity: { consumeUpgradeCommandV3: async () => command as any } as any,
		mcpV2Enabled: false,
		mcpV3Enabled: true,
		mcpReconfigureEnabled: true,
		mcpUpgradeEnabled: true,
		clusterMasterIdentity: {
			signUpgradeAcknowledgement: async (input: any) => {
				assert.equal(input.state, 'REFUSED');
				assert.equal(input.runningManifestDigest, command.previousManifestDigest, 'nothing moved — still the previous digest');
				return { compact: 'header.payload.signature', artifactHash: 'A'.repeat(43), kid: 'kid-1' };
			},
		} as any,
		mcpReleaseAuthorityJwks: [],
	}));
	await fastify.ready();
	const response = await fastify.inject({
		method: 'POST',
		url: '/w/workspace-1/api/v1/mcp/v3/apps/runtime-1/upgrade',
		headers: { authorization: 'Bearer test' },
		payload: {
			upgradeCommandJws: 'signed',
			issuer: 'urn:privos:hub:deployment-1',
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 1,
			clusterAppId: 'cluster-app-1',
			mcpAppId: 'mcp-app-1',
			resourceManifestHash: 'r'.repeat(43),
			runtimeResourceInventoryHash: 'i'.repeat(43),
		},
	});
	assert.equal(response.statusCode, 409);
	const json = response.json();
	assert.equal(json.state, 'REFUSED');
	assert.ok(json.acknowledgement, 'a 409 refusal must carry a signed acknowledgement');
});

test('a CAPACITY_UNAVAILABLE refusal (no active node) carries a signed REFUSED acknowledgement, not a bare {error}', async (t) => {
	const fastify = Fastify();
	t.after(() => fastify.close());
	const command = {
		operationId: '33333333-3333-4333-8333-333333333333',
		clusterId: 'cluster-1',
		workspaceId: 'workspace-1',
		deploymentId: 'deployment-1',
		generationId: 'generation-1',
		generationNumber: 1,
		revision: 2,
		runtimeInstallationId: 'runtime-1',
		clusterAppId: 'cluster-app-1',
		mcpAppId: 'mcp-app-1',
		targetManifestDigest: `sha256:${'f'.repeat(64)}`,
		targetImageDigest: `sha256:${'f'.repeat(64)}`,
		previousManifestDigest: `sha256:${'e'.repeat(64)}`,
		previousImageDigest: `sha256:${'e'.repeat(64)}`,
		resourceManifestHash: 'r'.repeat(43),
		runtimeResourceInventoryHash: 'i'.repeat(43),
		authorizationEpoch: 7,
		upgradeEpoch: 2,
	};
	await fastify.register(hubFacingRoutes({
		auth: { verify: async (workspaceId: string) => ({ workspaceId }) } as any,
		deployment: {} as any,
		lifecycle: {} as any,
		repositories: {
			apps: { findOne: async () => ({ image: 'registry.example/app', workspaceId: 'workspace-1', manifestDigest: command.previousManifestDigest, imageDigest: command.previousImageDigest }) },
			nodes: { findOne: async () => null },
		} as any,
		agentClient: { request: async () => { throw new Error('must not be reached'); } } as any,
		baseDomain: 'apps.example.com',
		mcpSecurity: { consumeUpgradeCommandV3: async () => command as any } as any,
		mcpV2Enabled: false,
		mcpV3Enabled: true,
		mcpReconfigureEnabled: true,
		mcpUpgradeEnabled: true,
		clusterMasterIdentity: {
			signUpgradeAcknowledgement: async (input: any) => {
				assert.equal(input.state, 'REFUSED');
				return { compact: 'header.payload.signature', artifactHash: 'A'.repeat(43), kid: 'kid-1' };
			},
		} as any,
		mcpReleaseAuthorityJwks: [],
	}));
	await fastify.ready();
	const response = await fastify.inject({
		method: 'POST',
		url: '/w/workspace-1/api/v1/mcp/v3/apps/runtime-1/upgrade',
		headers: { authorization: 'Bearer test' },
		payload: {
			upgradeCommandJws: 'signed',
			issuer: 'urn:privos:hub:deployment-1',
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 1,
			clusterAppId: 'cluster-app-1',
			mcpAppId: 'mcp-app-1',
			resourceManifestHash: 'r'.repeat(43),
			runtimeResourceInventoryHash: 'i'.repeat(43),
		},
	});
	assert.equal(response.statusCode, 409);
	const json = response.json();
	assert.equal(json.state, 'REFUSED');
	assert.equal(json.error, 'CAPACITY_UNAVAILABLE');
	assert.ok(json.acknowledgement, 'a 409 refusal must carry a signed acknowledgement, not a bare {error} the Hub would dereference');
});

test('the inspect reference drops the running digest pin, so an upgrade can name a different image', async (t) => {
	// A live app row carries `image` pinned to the digest it is RUNNING. An
	// upgrade exists to move off that digest, and the agent's resolver refuses a
	// reference whose existing pin disagrees with the requested one. Passing the
	// row verbatim therefore fails every upgrade before any container is touched
	// — invisible here until the fixture is pinned the way production is.
	const fastify = Fastify();
	t.after(() => fastify.close());
	const runningDigest = `sha256:${'a'.repeat(64)}`;
	const targetDigest = `sha256:${'f'.repeat(64)}`;
	let inspectPayload: any;
	const command = {
		operationId: '55555555-5555-4555-8555-555555555555',
		clusterId: 'cluster-1', workspaceId: 'workspace-1', deploymentId: 'deployment-1',
		generationId: 'generation-1', generationNumber: 1, revision: 1,
		runtimeInstallationId: 'runtime-1', clusterAppId: 'cluster-app-1', mcpAppId: 'mcp-app-1',
		targetManifestDigest: targetDigest, targetImageDigest: targetDigest,
		previousManifestDigest: runningDigest, previousImageDigest: runningDigest,
		resourceManifestHash: 'r'.repeat(43), runtimeResourceInventoryHash: 'i'.repeat(43),
		authorizationEpoch: 7, upgradeEpoch: 1,
	};
	await fastify.register(hubFacingRoutes({
		auth: { verify: async (workspaceId: string) => ({ workspaceId }) } as any,
		deployment: {
			publicUrlFor: (s: string) => `https://${s}.apps.example.com`,
			upgradeMcpV3: async () => ({
				app: { appId: 'cluster-app-1', subdomain: 'library-app', manifestDigest: targetDigest, imageDigest: targetDigest, updatedAt: new Date() },
				swapStrategy: 'STOP_THEN_CREATE',
			}),
		} as any,
		lifecycle: {} as any,
		repositories: {
			apps: { findOne: async () => ({ image: `registry.example/app@${runningDigest}`, workspaceId: 'workspace-1' }) },
			nodes: { findOne: async () => ({ nodeId: 'node-1' }) },
		} as any,
		agentClient: {
			request: async (_n: any, _w: any, _m: any, _p: any, body: any) => {
				inspectPayload = body;
				return { status: 200, body: { imageDigest: targetDigest, manifestDigest: targetDigest } };
			},
		} as any,
		baseDomain: 'apps.example.com',
		mcpSecurity: { consumeUpgradeCommandV3: async () => command as any } as any,
		mcpV2Enabled: false, mcpV3Enabled: true, mcpReconfigureEnabled: true, mcpUpgradeEnabled: true,
		clusterMasterIdentity: {
			signUpgradeAcknowledgement: async () => ({ compact: 'h.p.s', artifactHash: 'A'.repeat(43), kid: 'kid-1' }),
		} as any,
		mcpReleaseAuthorityJwks: [],
	}));
	await fastify.ready();
	const response = await fastify.inject({
		method: 'POST', url: '/w/workspace-1/api/v1/mcp/v3/apps/runtime-1/upgrade',
		headers: { authorization: 'Bearer test' },
		payload: {
			upgradeCommandJws: 'signed', issuer: 'urn:privos:hub:deployment-1', deploymentId: 'deployment-1',
			generationId: 'generation-1', generationNumber: 1, clusterAppId: 'cluster-app-1', mcpAppId: 'mcp-app-1',
			resourceManifestHash: 'r'.repeat(43), runtimeResourceInventoryHash: 'i'.repeat(43),
		},
	});
	assert.equal(response.statusCode, 200);
	assert.equal(inspectPayload.image, 'registry.example/app');
	assert.ok(!inspectPayload.image.includes('@'), 'the inspect reference must carry no digest pin');
	assert.equal(inspectPayload.digest, targetDigest);
});
