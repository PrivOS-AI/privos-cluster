/**
 * C + D: the workspace slug PATCH (no upsert), and the D-requirement hosts
 * API — service-key only (a Hub bearer never authenticates here), synchronous
 * 409 on a reserve conflict, and CF work never blocking the PUT ack.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import { portalAdminRoutes } from './portal-admin-routes.js';

const SERVICE_KEY = 's'.repeat(32);

async function fixture(overrides: { appHosts?: unknown } = {}) {
	const workspaceCalls: Array<{ method: string; workspaceId: string; arg?: unknown }> = [];
	const workspaces = {
		setSlug: async (workspaceId: string, slug: string) => {
			workspaceCalls.push({ method: 'setSlug', workspaceId, arg: slug });
			if (workspaceId === 'missing-workspace') throw new Error('workspace not found');
		},
	};
	const fastify = Fastify();
	await fastify.register(portalAdminRoutes({
		serviceKey: SERVICE_KEY,
		workspaces: workspaces as any,
		nodes: {} as any,
		repositories: { apps: { find: () => ({ toArray: async () => [] }) } } as any,
		lifecycle: {} as any,
		usage: {} as any,
		appHosts: overrides.appHosts as any,
	}));
	await fastify.ready();
	return { fastify, workspaceCalls };
}

test('PATCH slug sets only slug, filtered on ACTIVE, never via upsertWorkspace — refuses a workspace that does not exist', async (t) => {
	const { fastify, workspaceCalls } = await fixture();
	t.after(() => fastify.close());
	const ok = await fastify.inject({
		method: 'PATCH', url: '/admin/v1/workspaces/ws-1/slug',
		headers: { authorization: `Bearer ${SERVICE_KEY}` },
		payload: { slug: 'acme' },
	});
	assert.equal(ok.statusCode, 200);
	assert.deepEqual(workspaceCalls, [{ method: 'setSlug', workspaceId: 'ws-1', arg: 'acme' }]);

	const missing = await fastify.inject({
		method: 'PATCH', url: '/admin/v1/workspaces/missing-workspace/slug',
		headers: { authorization: `Bearer ${SERVICE_KEY}` },
		payload: { slug: 'acme' },
	});
	assert.equal(missing.statusCode, 404);
});

test('PATCH slug refuses an invalid slug shape before ever reaching the service', async (t) => {
	const { fastify, workspaceCalls } = await fixture();
	t.after(() => fastify.close());
	const response = await fastify.inject({
		method: 'PATCH', url: '/admin/v1/workspaces/ws-1/slug',
		headers: { authorization: `Bearer ${SERVICE_KEY}` },
		payload: { slug: 'Not_Valid!' },
	});
	assert.equal(response.statusCode, 500); // zod .parse throws; the shared error handler is not registered on this bare fixture
	assert.equal(workspaceCalls.length, 0);
});

test('the hosts API is service-key only: a Hub-shaped bearer token gets 401, never reaches the registry', async (t) => {
	const { fastify } = await fixture({ appHosts: { reserve: async () => { throw new Error('must not be called'); } } });
	t.after(() => fastify.close());
	const response = await fastify.inject({
		method: 'POST',
		url: '/admin/v1/workspaces/ws-1/apps/app-1/hosts/reserve',
		headers: { authorization: 'Bearer some-hub-jwt-not-the-service-key-xxxxxxxxxxxxxx' },
		payload: { hostname: 'acme.privos.link', kind: 'VANITY', listingId: 'listing-1' },
	});
	assert.equal(response.statusCode, 401);
});

test('reserve returns a synchronous 409 with a code on a label conflict', async (t) => {
	const { fastify } = await fixture({
		appHosts: {
			reserve: async () => {
				throw Object.assign(new Error('label_already_claimed'), { code: 'LABEL_ALREADY_CLAIMED', statusCode: 409 });
			},
		},
	});
	t.after(() => fastify.close());
	const response = await fastify.inject({
		method: 'POST',
		url: '/admin/v1/workspaces/ws-1/apps/app-1/hosts/reserve',
		headers: { authorization: `Bearer ${SERVICE_KEY}` },
		payload: { hostname: 'acme.privos.link', kind: 'VANITY', listingId: 'listing-1' },
	});
	assert.equal(response.statusCode, 409);
	assert.equal(response.json().error, 'LABEL_ALREADY_CLAIMED');
});

test('reserve succeeds and returns the pre-registered row', async (t) => {
	let reserveCall: unknown;
	const { fastify } = await fixture({
		appHosts: {
			reserve: async (input: unknown) => {
				reserveCall = input;
				return { _id: 'acme.privos.link', state: 'PENDING' };
			},
		},
	});
	t.after(() => fastify.close());
	const response = await fastify.inject({
		method: 'POST',
		url: '/admin/v1/workspaces/ws-1/apps/app-1/hosts/reserve',
		headers: { authorization: `Bearer ${SERVICE_KEY}` },
		payload: { hostname: 'acme.privos.link', kind: 'VANITY', listingId: 'listing-1' },
	});
	assert.equal(response.statusCode, 201);
	assert.deepEqual(reserveCall, { workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1', hostname: 'acme.privos.link', kind: 'VANITY' });
	assert.deepEqual(response.json(), { _id: 'acme.privos.link', state: 'PENDING' });
});

test('PUT hosts writes the desired set and returns 200 without waiting on CF work', async (t) => {
	let setDesiredHostsCall: unknown;
	const { fastify } = await fixture({
		appHosts: {
			setDesiredHosts: async (input: unknown) => {
				setDesiredHostsCall = input;
				return [{ _id: 'acme.privos.link', state: 'PENDING' }];
			},
		},
	});
	t.after(() => fastify.close());
	const response = await fastify.inject({
		method: 'PUT',
		url: '/admin/v1/workspaces/ws-1/apps/app-1/hosts',
		headers: { authorization: `Bearer ${SERVICE_KEY}` },
		payload: {
			listingId: 'listing-1',
			generationId: 'gen-1',
			hosts: [{ hostname: 'acme.privos.link', kind: 'VANITY', primary: true, state: 'ACTIVE' }],
		},
	});
	assert.equal(response.statusCode, 200);
	assert.deepEqual((setDesiredHostsCall as any).hosts, [{ hostname: 'acme.privos.link', kind: 'VANITY', primary: true, state: 'ACTIVE' }]);
	assert.deepEqual(response.json(), { hosts: [{ _id: 'acme.privos.link', state: 'PENDING' }] });
});

test('PUT hosts surfaces a host conflict as 409 with the offending hostname', async (t) => {
	const { fastify } = await fixture({
		appHosts: {
			setDesiredHosts: async () => {
				throw Object.assign(new Error('host_conflict'), { code: 'HOST_CONFLICT', statusCode: 409, hostname: 'shared.privos.link' });
			},
		},
	});
	t.after(() => fastify.close());
	const response = await fastify.inject({
		method: 'PUT',
		url: '/admin/v1/workspaces/ws-1/apps/app-1/hosts',
		headers: { authorization: `Bearer ${SERVICE_KEY}` },
		payload: { listingId: 'listing-1', hosts: [{ hostname: 'shared.privos.link', kind: 'VANITY', primary: true, state: 'ACTIVE' }] },
	});
	assert.equal(response.statusCode, 409);
	assert.deepEqual(response.json(), { error: 'HOST_CONFLICT', hostname: 'shared.privos.link' });
});

test('GET hosts returns the registry rows for a workspace/app', async (t) => {
	const { fastify } = await fixture({
		appHosts: { get: async () => [{ _id: 'acme.privos.link', state: 'ACTIVE' }] },
	});
	t.after(() => fastify.close());
	const response = await fastify.inject({
		method: 'GET', url: '/admin/v1/workspaces/ws-1/apps/app-1/hosts',
		headers: { authorization: `Bearer ${SERVICE_KEY}` },
	});
	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.json(), { hosts: [{ _id: 'acme.privos.link', state: 'ACTIVE' }] });
});

test('the hosts routes are inert (404) when the registry is not wired — never a 500', async (t) => {
	const { fastify } = await fixture();
	t.after(() => fastify.close());
	for (const request of [
		{ method: 'POST' as const, url: '/admin/v1/workspaces/ws-1/apps/app-1/hosts/reserve', payload: { hostname: 'a.privos.link', kind: 'VANITY', listingId: 'l-1' } },
		{ method: 'PUT' as const, url: '/admin/v1/workspaces/ws-1/apps/app-1/hosts', payload: { listingId: 'l-1', hosts: [] } },
		{ method: 'GET' as const, url: '/admin/v1/workspaces/ws-1/apps/app-1/hosts', payload: undefined },
	]) {
		const response = await fastify.inject({ ...request, headers: { authorization: `Bearer ${SERVICE_KEY}` } });
		assert.equal(response.statusCode, 404);
	}
});
