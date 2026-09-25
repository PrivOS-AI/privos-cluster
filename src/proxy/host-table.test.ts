import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';

import hostTableHandler, { resetHostTablesForTests } from '../handlers/host-table.js';
import { findRuntimeAppByHost, findIngressRuleByHost, findSigningKey, ingressTableAgeMs } from './host-table.js';

async function fixture() {
	resetHostTablesForTests();
	const fastify = Fastify();
	fastify.decorate('authenticate', async (req: FastifyRequest, _reply: FastifyReply) => {
		req.clusterAuth = { iss: 'privos-apps-master', sub: 'apps-master-fleet', workspaceId: '__fleet__' };
	});
	await fastify.register(hostTableHandler);
	await fastify.ready();
	return fastify;
}

const headers = { authorization: 'Bearer irrelevant-stubbed-auth' };

test('findRuntimeAppByHost / findIngressRuleByHost / findSigningKey read the latest pushed table', async (t) => {
	const fastify = await fixture();
	t.after(() => fastify.close());

	await fastify.inject({
		method: 'PUT', url: '/api/v1/fleet/host-table/runtime', headers,
		payload: { bootTimestamp: 1, revision: 1, apps: [{ appId: 'app-1', workspaceId: 'ws-1', containerId: 'c-1', hosts: ['shop--acme.privos.link'] }] },
	});
	await fastify.inject({
		method: 'PUT', url: '/api/v1/fleet/host-table/ingress', headers,
		payload: {
			bootTimestamp: 1, revision: 1,
			rules: [{ host: 'shop--acme.privos.link', appId: 'app-1', workspaceId: 'ws-1', nodes: ['10.88.0.11'], suspended: false }],
			signingKeys: [{ nodeId: 'app-eu-01', kid: 'kid-1', publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'AA' } }],
		},
	});

	assert.equal(findRuntimeAppByHost('shop--acme.privos.link')?.appId, 'app-1');
	assert.equal(findRuntimeAppByHost('unknown.privos.link'), undefined);
	assert.equal(findIngressRuleByHost('shop--acme.privos.link')?.nodes[0], '10.88.0.11');
	assert.equal(findIngressRuleByHost('unknown.privos.link'), undefined);
	assert.equal(findSigningKey('kid-1')?.nodeId, 'app-eu-01');
	assert.equal(findSigningKey('unknown-kid'), undefined);
});

test('ingressTableAgeMs is null before any push, and grows with wall time after one', async (t) => {
	const fastify = await fixture();
	t.after(() => fastify.close());

	assert.equal(ingressTableAgeMs(Date.now()), null);

	const before = Date.now();
	await fastify.inject({
		method: 'PUT', url: '/api/v1/fleet/host-table/ingress', headers,
		payload: { bootTimestamp: 1, revision: 1, rules: [], signingKeys: [] },
	});
	const age = ingressTableAgeMs(before + 10_000);
	assert.ok(age !== null && age >= 9_000 && age < 11_000, `expected ~10000ms, got ${age}`);
});
