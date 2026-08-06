import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';

test('agent rejects an invalid v3 assertion before forwarding caller headers or contacting the app', async (t) => {
	process.env.APP_CLUSTER_MCP_INSTALL_V3 = 'on';
	const [{ default: appsHandler }, { containerManager }] = await Promise.all([
		import('./apps.js'),
		import('../docker/index.js'),
	]);
	const labels = {
		'privos.managed': 'true',
		'privos.id': '11111111-2222-4333-8444-555555555555',
		'privos.mcp.schema': '3',
		'privos.port': '3001',
	};
	const inspect = {
		Id: 'docker-1',
		Name: '/app-1',
		Created: '2026-08-06T00:00:00.000Z',
		State: { Status: 'running', StartedAt: '2026-08-06T00:00:01.000Z' },
		Config: { Image: 'example/app:latest', Labels: labels },
		NetworkSettings: { Ports: {}, Networks: { 'privos-ws-1': { IPAddress: '172.18.0.2' } } },
		Mounts: [],
	};
	t.mock.method(containerManager, 'listContainers', async () => [{ Id: inspect.Id }] as any);
	t.mock.method(containerManager, 'inspectContainer', async () => inspect as any);
	let appRequests = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		appRequests += 1;
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	});

	const fastify = Fastify({ logger: false });
	fastify.decorate('authenticate', async () => undefined);
	await fastify.register(appsHandler);
	t.after(() => fastify.close());
	const sentinel = 'credential.sentinel.signature';
	const response = await fastify.inject({
		method: 'POST',
		url: '/api/v1/apps/11111111-2222-4333-8444-555555555555/dispatch',
		payload: {
			assertion: 'invalid.compact.assertion',
			rpc: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
			authorizationContext: 'room',
			runtimeInstallationId: 'runtime-1',
			authorizationBindingId: 'binding-1',
			runtimeResourceInventoryHash: 'i'.repeat(43),
			callerCredential: { token: sentinel, assertedUserId: 'user-1' },
		},
	});

	assert.equal(response.statusCode, 403);
	assert.equal(appRequests, 0);
	assert.equal(response.body.includes(sentinel), false);
});
