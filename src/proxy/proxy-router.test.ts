import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitHost, targetForContainer, createRouter } from './proxy-router.js';
import type { Container } from '../types/index.js';

const DOMAINS = ['privos.link', 'apps.example.com'];

function fakeContainer(overrides: Partial<Container> = {}): Container {
	return {
		id: 'c1', appId: null, workspaceId: null, listingId: null, versionDigest: null,
		dockerContainerId: 'd1', dockerContainerName: 'whoami-abc',
		image: 'traefik/whoami', tag: 'latest', state: 'running', internalUrl: 'http://localhost:49155',
		port: 3001, hostPort: 49155, resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 }, envVars: {},
		healthCheck: { status: 'healthy', failCount: 0, restartCount: 0, lastCheck: null },
		createdAt: 1, startedAt: null, stoppedAt: null, volumes: [], subdomain: 'whoami', domain: 'privos.link',
		...overrides,
	};
}

test('splitHost splits a one-level subdomain against configured base domains', () => {
	assert.deepEqual(splitHost('whoami.privos.link', DOMAINS), { subdomain: 'whoami', domain: 'privos.link' });
	assert.deepEqual(splitHost('todo.apps.example.com', DOMAINS), { subdomain: 'todo', domain: 'apps.example.com' });
	// Case + trailing dot + port are normalized away.
	assert.deepEqual(splitHost('WhoAmI.Privos.Link:443.', DOMAINS), { subdomain: 'whoami', domain: 'privos.link' });
});

test('splitHost rejects foreign hosts, apex, deeper subdomains, empty', () => {
	assert.equal(splitHost('whoami.evil.com', DOMAINS), null); // open-relay guard
	assert.equal(splitHost('privos.link', DOMAINS), null); // apex, no subdomain
	assert.equal(splitHost('a.b.privos.link', DOMAINS), null); // two-level → needs ACM
	assert.equal(splitHost('', DOMAINS), null);
	assert.equal(splitHost(undefined, DOMAINS), null);
	assert.equal(splitHost('whoami.privos.link', []), null); // no domains configured
});

test('targetForContainer health-gates non-running and prefers IP then host port', () => {
	const running = fakeContainer();
	assert.equal(targetForContainer(running, '172.18.0.5'), 'http://172.18.0.5:3001');
	assert.equal(targetForContainer(running, null), 'http://localhost:49155');
	assert.equal(targetForContainer(fakeContainer({ state: 'stopped' }), '172.18.0.5'), null);
	assert.equal(targetForContainer(fakeContainer({ hostPort: null }), null), null);
});

test('router resolves a running host to its container IP', async () => {
	const router = createRouter({
		findByHost: async () => fakeContainer(),
		getContainerIp: async () => '172.18.0.5',
		getDomains: () => DOMAINS,
	});
	assert.deepEqual(await router.resolve('whoami.privos.link'), { url: 'http://172.18.0.5:3001', containerId: 'c1' });
});

test('router returns null for foreign host, missing container, and non-running (health gate)', async () => {
	const base = { getContainerIp: async () => '172.18.0.5', getDomains: () => DOMAINS };
	assert.equal(await createRouter({ ...base, findByHost: async () => fakeContainer() }).resolve('x.evil.com'), null);
	assert.equal(await createRouter({ ...base, findByHost: async () => null }).resolve('whoami.privos.link'), null);
	assert.equal(
		await createRouter({ ...base, findByHost: async () => fakeContainer({ state: 'stopped' }) }).resolve('whoami.privos.link'),
		null,
	);
});

test('router falls back to host port when the container IP is unavailable', async () => {
	const router = createRouter({
		findByHost: async () => fakeContainer(),
		getContainerIp: async () => { throw new Error('no network'); },
		getDomains: () => DOMAINS,
	});
	assert.deepEqual(await router.resolve('whoami.privos.link'), { url: 'http://localhost:49155', containerId: 'c1' });
});

test('router caches within TTL and refreshRoutes invalidates', async () => {
	let calls = 0;
	let clock = 0;
	const router = createRouter({
		findByHost: async () => { calls++; return fakeContainer(); },
		getContainerIp: async () => '172.18.0.5',
		getDomains: () => DOMAINS,
		now: () => clock,
		ttlMs: 5_000,
	});

	await router.resolve('whoami.privos.link');
	await router.resolve('whoami.privos.link');
	assert.equal(calls, 1, 'second lookup served from cache');

	clock = 6_000; // past TTL
	await router.resolve('whoami.privos.link');
	assert.equal(calls, 2, 'expired entry re-resolved');

	router.refreshRoutes(); // explicit invalidation (e.g. after a deploy)
	await router.resolve('whoami.privos.link');
	assert.equal(calls, 3, 'refreshRoutes cleared the cache');
});
