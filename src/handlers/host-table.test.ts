/**
 * H1: acceptance is ordered by `revision` ALONE. A delayed push carrying a
 * lower revision than one already stored must be rejected, whatever it
 * claims about its own boot (there is no `masterEpoch` tiebreak anymore).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';

import hostTableHandler, { currentHostTables, resetHostTablesForTests } from './host-table.js';

async function fixture() {
	resetHostTablesForTests();
	const fastify = Fastify();
	// Stubs the real crypto/config-backed auth plugin: this test proves the
	// route's OWN revision-ordering logic, not the fleet-JWT verification
	// (covered by `agent-client.ts`'s own tests).
	fastify.decorate('authenticate', async (req: FastifyRequest, _reply: FastifyReply) => {
		req.clusterAuth = { iss: 'privos-apps-master', sub: 'apps-master-fleet', workspaceId: '__fleet__' };
	});
	await fastify.register(hostTableHandler);
	await fastify.ready();
	return fastify;
}

const headers = { authorization: 'Bearer irrelevant-stubbed-auth' };

test('a higher-revision push is applied; a delayed LOWER-revision push afterwards is rejected, not applied out of order', async (t) => {
	const fastify = await fixture();
	t.after(() => fastify.close());

	const high = await fastify.inject({
		method: 'PUT', url: '/api/v1/fleet/host-table/runtime', headers,
		payload: { bootTimestamp: 1_000, revision: 5, apps: [{ appId: 'app-new', workspaceId: 'ws-1', containerId: 'c-1', hosts: [] }] },
	});
	assert.equal(high.statusCode, 200);
	assert.deepEqual(high.json(), { applied: true, revision: 5 });

	// A delayed push from an OLDER boot (lower bootTimestamp) but ALSO a lower
	// revision — the realistic case this fix targets (a stale in-flight retry
	// landing after a newer push already won).
	const delayed = await fastify.inject({
		method: 'PUT', url: '/api/v1/fleet/host-table/runtime', headers,
		payload: { bootTimestamp: 500, revision: 3, apps: [{ appId: 'app-stale', workspaceId: 'ws-1', containerId: 'c-2', hosts: [] }] },
	});
	assert.equal(delayed.statusCode, 200);
	assert.deepEqual(delayed.json(), { applied: false, revision: 5 }, 'a lower revision is REJECTED, whatever bootTimestamp it carries');

	const { runtimeTable } = currentHostTables();
	assert.equal(runtimeTable?.revision, 5);
	assert.deepEqual(runtimeTable?.table.map((entry) => entry.appId), ['app-new'], 'the stale push must never overwrite the newer one');
});

test('a HIGHER bootTimestamp with a LOWER revision is still rejected — bootTimestamp never overrides revision', async (t) => {
	const fastify = await fixture();
	t.after(() => fastify.close());

	await fastify.inject({
		method: 'PUT', url: '/api/v1/fleet/host-table/ingress', headers,
		payload: { bootTimestamp: 1, revision: 10, rules: [{ host: 'a.privos.link', appId: 'app-1', workspaceId: 'ws-1', nodes: [], suspended: false }], signingKeys: [] },
	});
	// A brand-new master boot (very high bootTimestamp) that has only reached
	// a low revision so far — e.g. it just started and has not caught up to
	// the shared Mongo counter's current value yet.
	const fromNewerBootLowerRevision = await fastify.inject({
		method: 'PUT', url: '/api/v1/fleet/host-table/ingress', headers,
		payload: { bootTimestamp: 999_999_999, revision: 2, rules: [], signingKeys: [] },
	});
	assert.deepEqual(fromNewerBootLowerRevision.json(), { applied: false, revision: 10 });
});

test('equal revision is not "newer" — replaying the same push is a no-op, not an error', async (t) => {
	const fastify = await fixture();
	t.after(() => fastify.close());
	const payload = { bootTimestamp: 1, revision: 7, apps: [] as never[] };
	const first = await fastify.inject({ method: 'PUT', url: '/api/v1/fleet/host-table/runtime', headers, payload });
	const replay = await fastify.inject({ method: 'PUT', url: '/api/v1/fleet/host-table/runtime', headers, payload });
	assert.deepEqual(first.json(), { applied: true, revision: 7 });
	assert.deepEqual(replay.json(), { applied: false, revision: 7 });
});
