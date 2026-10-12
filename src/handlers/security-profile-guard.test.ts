/**
 * Outside fleet mode the agent also accepts Hub-issued tokens, so a non-null
 * runtime security profile on deploy, reconfigure or redeploy must be refused
 * with a stable code; null and absent stay accepted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fastify from 'fastify';

import { config } from '../config.js';
import appsHandler from './apps.js';
import mcpHandler from './mcp.js';

const digest = `sha256:${'a'.repeat(64)}`;
const hash43 = 'h'.repeat(43);

function binding(extra: Record<string, unknown> = {}) {
	return {
		protocolVersion: 3, clusterId: 'cluster-1', nodeId: 'node-1', workspaceId: 'workspace-1',
		deploymentId: 'deployment-1', generationId: 'generation-1', generationNumber: 1,
		runtimeInstallationId: 'runtime-1', mcpAppId: 'mcp-app-1',
		replicaId: '11111111-1111-4111-8111-111111111111', containerId: '22222222-2222-4222-8222-222222222222',
		imageDigest: digest, manifestDigest: digest, approvalReceiptHash: hash43, authorizationEpoch: 1,
		deploymentGrantHash: hash43, resourceManifestHash: hash43, ...extra,
	};
}

const deployBody = (extra: Record<string, unknown>) => ({
	appId: 'cluster-app-1', workspaceId: 'workspace-1', image: 'registry.example/app', digest, port: 3001,
	mcpV3Binding: binding({ hubOrigin: 'https://hub.example.com', hubKid: 'k'.repeat(24), hubPublicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } }),
	...extra,
});
const reconfigureBody = (extra: Record<string, unknown>) => ({
	appId: 'cluster-app-1', workspaceId: 'workspace-1', image: 'registry.example/app', digest, port: 3001,
	mcpV3Binding: binding(), configEpoch: 2, runtimeResourceInventoryHash: hash43, ...extra,
});

async function build(t: import('node:test').TestContext) {
	const saved = { FLEET_MODE: config.FLEET_MODE, install: config.APP_CLUSTER_MCP_INSTALL_V3, proxy: config.REVERSE_PROXY_MODE };
	(config as any).FLEET_MODE = false;
	(config as any).APP_CLUSTER_MCP_INSTALL_V3 = 'on';
	(config as any).REVERSE_PROXY_MODE = 'native';
	const app = fastify();
	app.decorate('authenticate', async () => undefined);
	await app.register(appsHandler);
	await app.register(mcpHandler);
	await app.ready();
	t.after(async () => {
		Object.assign(config, { FLEET_MODE: saved.FLEET_MODE, APP_CLUSTER_MCP_INSTALL_V3: saved.install, REVERSE_PROXY_MODE: saved.proxy });
		await app.close();
	});
	return app;
}

const routes = [
	{ name: 'v3 deploy', url: '/api/v1/mcp/v3/apps/deploy', body: deployBody },
	{ name: 'v3 reconfigure', url: '/api/v1/mcp/v3/apps/22222222-2222-4222-8222-222222222222/reconfigure', body: reconfigureBody },
	{ name: 'redeploy', url: '/api/v1/apps/22222222-2222-4222-8222-222222222222/redeploy', body: (extra: Record<string, unknown>) => extra },
];

for (const route of routes) {
	test(`non-fleet mode refuses a non-null securityProfile on ${route.name}`, async (t) => {
		const app = await build(t);
		const response = await app.inject({ method: 'POST', url: route.url, payload: route.body({ securityProfile: 'browser-sandbox' }) });
		assert.equal(response.statusCode, 400);
		assert.equal(response.json().error, 'security_profile_not_allowed');
	});

	test(`non-fleet mode does not refuse a null or absent securityProfile on ${route.name}`, async (t) => {
		const app = await build(t);
		for (const extra of [{ securityProfile: null }, {}]) {
			const response = await app.inject({ method: 'POST', url: route.url, payload: route.body(extra) });
			// Past the guard the request may fail for unrelated reasons (no Docker here); it must not be this refusal.
			assert.notEqual(response.json().error, 'security_profile_not_allowed');
			assert.notEqual(response.json().error, 'validation_error', 'the fixture body must be schema-valid so the guard is what is under test');
		}
	});
}
