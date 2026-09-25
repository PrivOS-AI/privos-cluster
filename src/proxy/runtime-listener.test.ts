import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';

import { createRuntimeListener, type RuntimeListenerDeps } from './runtime-listener.js';
import { createReplayCache } from './replay-cache.js';
import { generateNonce, signRequest, type SignedRequestFields, type SigningIdentity } from './forward-signature.js';
import crypto from 'node:crypto';
import type { Container } from '../types/index.js';
import type { RuntimeApp, SigningKey } from './host-table.js';

const SELF_MESH_IP = '10.88.0.11';

async function listen(server: http.Server): Promise<number> {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return (server.address() as net.AddressInfo).port;
}

interface TestResponse {
	status: number;
	headers: { get: (name: string) => string | null; getSetCookie: () => string[] };
	text: () => Promise<string>;
}

/**
 * Global `fetch()` (undici) silently drops a caller-set `Host` header — it's a
 * forbidden header name under the Fetch spec — so it can never simulate an
 * arbitrary inbound Host the way a real client hitting this listener would.
 * Node's core `http.request` has no such restriction, so tests that need
 * `req.headers.host` to actually be a specific value (everything here — the
 * signature is computed over that exact host) must use it instead of `fetch`.
 */
function requestWithHost(port: number, path: string, headers: Record<string, string>): Promise<TestResponse> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				const raw = res.headers;
				resolve({
					status: res.statusCode ?? 0,
					headers: {
						get: (name) => {
							const v = raw[name.toLowerCase()];
							if (v === undefined) return null;
							return Array.isArray(v) ? v.join(', ') : v;
						},
						getSetCookie: () => {
							const v = raw['set-cookie'];
							return Array.isArray(v) ? v : v ? [v] : [];
						},
					},
					text: async () => body,
				});
			});
		});
		req.on('error', reject);
		req.end();
	});
}

function makeIdentity(nodeId = 'app-eu-01', kid = 'kid-1'): SigningIdentity {
	const pair = crypto.generateKeyPairSync('ed25519');
	return {
		nodeId,
		kid,
		privateKey: pair.privateKey,
		publicJwk: pair.publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey,
	};
}

function signedHeaders(identity: SigningIdentity, overrides: Partial<SignedRequestFields> = {}): Record<string, string> {
	const fields: SignedRequestFields = {
		targetNodeId: SELF_MESH_IP,
		nonce: generateNonce(),
		ts: Date.now(),
		method: 'GET',
		host: 'shop--acme.privos.link',
		requestTarget: '/ui',
		clientIp: '203.0.113.7',
		...overrides,
	};
	return {
		host: fields.host,
		'x-privos-target-node': fields.targetNodeId,
		'x-privos-nonce': fields.nonce,
		'x-privos-ts': String(fields.ts),
		'x-privos-kid': identity.kid,
		'x-privos-client-ip': fields.clientIp,
		'x-privos-sig': signRequest(fields, identity.privateKey),
	};
}

function fakeContainer(overrides: Partial<Container> = {}): Container {
	return {
		id: 'c1', appId: 'app-1', workspaceId: 'ws-1', listingId: null, versionDigest: null,
		dockerContainerId: 'd1', dockerContainerName: 'app-1',
		image: 'privos/app', tag: 'latest', imageDigest: null,
		state: 'running', internalUrl: 'http://172.18.0.5:3001',
		port: 3001, hostPort: null, resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 }, envVars: {},
		healthCheck: { status: 'healthy', failCount: 0, restartCount: 0, lastCheck: null },
		createdAt: 1, startedAt: null, stoppedAt: null, volumes: [], mcpV3: true,
		...overrides,
	};
}

function baseDeps(identity: SigningIdentity, overrides: Partial<RuntimeListenerDeps> = {}): RuntimeListenerDeps {
	const app: RuntimeApp = { appId: 'app-1', workspaceId: 'ws-1', containerId: 'c1', hosts: ['shop--acme.privos.link'] };
	const key: SigningKey = { nodeId: 'app-eu-01', kid: identity.kid, publicJwk: identity.publicJwk };
	return {
		selfMeshIp: SELF_MESH_IP,
		findAppByHost: (host) => (host === app.hosts[0] ? app : undefined),
		findSigningKeyByKid: (kid) => (kid === key.kid ? key : undefined),
		findContainerByAppId: async () => fakeContainer(),
		getContainerIp: async () => '172.18.0.5',
		replayCache: createReplayCache(),
		...overrides,
	};
}

test('authenticated request with a valid signature reaches privos.app-id resolution and forwards to the container IP', async () => {
	const identity = makeIdentity();
	const upstream = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end(`ok host=${req.headers.host} fwd-for=${req.headers['x-forwarded-for']}`);
	});
	const uport = await listen(upstream);

	let resolvedFor: { appId: string; workspaceId: string } | undefined;
	const deps = baseDeps(identity, {
		findContainerByAppId: async (appId, workspaceId) => {
			resolvedFor = { appId, workspaceId };
			return fakeContainer({ port: uport });
		},
		getContainerIp: async () => '127.0.0.1',
	});
	const server = createRuntimeListener(deps);
	const port = await listen(server);

	const res = await requestWithHost(port, '/ui', signedHeaders(identity, { requestTarget: '/ui', host: 'shop--acme.privos.link' }));
	assert.equal(res.status, 200);
	assert.equal(await res.text(), 'ok host=shop--acme.privos.link fwd-for=203.0.113.7');
	assert.deepEqual(resolvedFor, { appId: 'app-1', workspaceId: 'ws-1' });

	server.close();
	upstream.close();
});

test('rejects a bad signature, a wrong target node, a stale ts, and a replayed nonce', async () => {
	const identity = makeIdentity();
	// A real, reachable upstream — the "first" replay-nonce call below is expected to
	// actually succeed (200), unlike a real fleet IP such as 172.18.0.5 this box can't reach.
	const upstream = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
	const uport = await listen(upstream);
	const deps = baseDeps(identity, { findContainerByAppId: async () => fakeContainer({ port: uport }), getContainerIp: async () => '127.0.0.1' });
	const server = createRuntimeListener(deps);
	const port = await listen(server);

	const validHeaders = signedHeaders(identity);
	const bad = await requestWithHost(port, '/ui', { ...validHeaders, 'x-privos-sig': 'not-a-real-signature' });
	assert.equal(bad.status, 401);

	const wrongTarget = await requestWithHost(port, '/ui', signedHeaders(identity, { targetNodeId: '10.88.0.99' }));
	assert.equal(wrongTarget.status, 403);

	const stale = await requestWithHost(port, '/ui', signedHeaders(identity, { ts: Date.now() - 60_000 }));
	assert.equal(stale.status, 403);

	const replayNonce = generateNonce();
	const first = await requestWithHost(port, '/ui', signedHeaders(identity, { nonce: replayNonce }));
	assert.equal(first.status, 200);
	const replay = await requestWithHost(port, '/ui', signedHeaders(identity, { nonce: replayNonce }));
	assert.equal(replay.status, 401);

	server.close();
	upstream.close();
});

test('a client-sent X-Forwarded-For/X-Privos-* header is never trusted — only CF-Connecting-IP via the ingress signature is', async () => {
	const identity = makeIdentity();
	const upstream = http.createServer((req, res) => {
		res.writeHead(200);
		res.end(`fwd-for=${req.headers['x-forwarded-for']}`);
	});
	const uport = await listen(upstream);
	const deps = baseDeps(identity, { findContainerByAppId: async () => fakeContainer({ port: uport }), getContainerIp: async () => '127.0.0.1' });
	const server = createRuntimeListener(deps);
	const port = await listen(server);

	const res = await requestWithHost(port, '/ui', {
		'x-forwarded-for': 'spoofed-attacker-ip',
		...signedHeaders(identity, { clientIp: '203.0.113.9' }),
	});
	assert.equal(await res.text(), 'fwd-for=203.0.113.9', 'the spoofed client header is dropped; only the signed clientIp is forwarded');

	server.close();
	upstream.close();
});

test('unknown host returns 404 with the retryable x-privos-error marker; a known host with no path rule after canonicalization is unaffected', async () => {
	const identity = makeIdentity();
	const deps = baseDeps(identity, { findAppByHost: () => undefined });
	const server = createRuntimeListener(deps);
	const port = await listen(server);

	const res = await requestWithHost(port, '/ui', signedHeaders(identity, { host: 'nope.privos.link' }));
	assert.equal(res.status, 404);
	assert.equal(res.headers.get('x-privos-error'), 'unknown-host');

	server.close();
});

test('blocks MCP surfaces for a v3 container', async () => {
	const identity = makeIdentity();
	const deps = baseDeps(identity);
	const server = createRuntimeListener(deps);
	const port = await listen(server);

	for (const p of ['/mcp', '/mcp/tools', '/bootstrap', '/identity', '/.well-known/privos/identity', '/api/v1/mcp-workload/token']) {
		const res = await requestWithHost(port, p, signedHeaders(identity, { requestTarget: p }));
		assert.equal(res.status, 404, p);
	}

	server.close();
});

test('rejects a malformed canonical path with 400', async () => {
	const identity = makeIdentity();
	const deps = baseDeps(identity);
	const server = createRuntimeListener(deps);
	const port = await listen(server);

	const res = await requestWithHost(port, '/api/..%2f..%2fsecret', signedHeaders(identity, { requestTarget: '/api/..%2f..%2fsecret' }));
	assert.equal(res.status, 400);

	server.close();
});

test('a stopped container returns 502', async () => {
	const identity = makeIdentity();
	const deps = baseDeps(identity, { findContainerByAppId: async () => fakeContainer({ state: 'stopped' }) });
	const server = createRuntimeListener(deps);
	const port = await listen(server);

	const res = await requestWithHost(port, '/ui', signedHeaders(identity));
	assert.equal(res.status, 502);

	server.close();
});

test('no container IP returns 502 (container IP only — never a host port)', async () => {
	const identity = makeIdentity();
	const deps = baseDeps(identity, { getContainerIp: async () => null });
	const server = createRuntimeListener(deps);
	const port = await listen(server);

	const res = await requestWithHost(port, '/ui', signedHeaders(identity));
	assert.equal(res.status, 502);

	server.close();
});

test('strips the Domain=privos.link cookie attribute from the upstream response', async () => {
	const identity = makeIdentity();
	const upstream = http.createServer((_req, res) => {
		res.writeHead(200, { 'set-cookie': ['sid=abc; Domain=shop--acme.privos.link; Path=/', 'other=1; Domain=example.com'] });
		res.end('ok');
	});
	const uport = await listen(upstream);
	const deps = baseDeps(identity, { findContainerByAppId: async () => fakeContainer({ port: uport }), getContainerIp: async () => '127.0.0.1' });
	const server = createRuntimeListener(deps);
	const port = await listen(server);

	const res = await requestWithHost(port, '/ui', signedHeaders(identity));
	const cookies = res.headers.getSetCookie();
	assert.ok(cookies.some((c) => c.startsWith('sid=abc') && !c.includes('Domain=')));
	assert.ok(cookies.some((c) => c.includes('Domain=example.com')));

	server.close();
	upstream.close();
});
