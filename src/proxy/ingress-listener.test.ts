import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { once } from 'node:events';

import { createIngressListener, type IngressListenerDeps } from './ingress-listener.js';
import type { SigningIdentity } from './forward-signature.js';
import type { IngressRule } from './host-table.js';

async function listen(server: http.Server): Promise<number> {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return (server.address() as net.AddressInfo).port;
}

/**
 * Global `fetch()` (undici) silently drops a caller-set `Host` header — it's a
 * forbidden header name under the Fetch spec — so it can never simulate a real
 * client's inbound Host. Node's core `http.request` has no such restriction;
 * use it whenever a test needs `req.headers.host` to actually carry a specific
 * value (e.g. asserting what gets forwarded to the runtime node).
 */
function requestWithHost(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; json: () => Promise<unknown> }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
		});
		req.on('error', reject);
		req.end();
	});
}

/** Opens a server on 127.0.0.1 to grab a free ephemeral port, then closes it —
 * dialing that port afterwards gets a genuine connection-refused, portably,
 * without needing a real second loopback address (127.0.0.2 is macOS-only). */
async function unusedPort(): Promise<number> {
	const probe = http.createServer();
	const port = await listen(probe);
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

function makeIdentity(): SigningIdentity {
	const pair = crypto.generateKeyPairSync('ed25519');
	return { nodeId: 'app-eu-01', kid: 'kid-1', privateKey: pair.privateKey, publicJwk: pair.publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey };
}

function baseDeps(overrides: Partial<IngressListenerDeps> = {}): IngressListenerDeps {
	return {
		nodeId: 'app-eu-01',
		selfMeshIp: '10.88.0.11',
		runtimeProxyPort: 9999, // overridden per-test where a real runtime port is needed
		findRuleByHost: () => undefined,
		signingIdentity: makeIdentity(),
		isTableStale: () => false,
		...overrides,
	};
}

test('/_privos/ingress-id returns the configured node id', async () => {
	const server = createIngressListener(baseDeps({ nodeId: 'app-eu-01' }));
	const port = await listen(server);
	const res = await fetch(`http://127.0.0.1:${port}/_privos/ingress-id`);
	assert.equal(await res.text(), 'app-eu-01');
	server.close();
});

test('/healthz is 503 when the table is stale or missing, 200 otherwise', async () => {
	const server = createIngressListener(baseDeps({ isTableStale: () => true }));
	const port = await listen(server);
	assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 503);
	server.close();

	const server2 = createIngressListener(baseDeps({ isTableStale: () => false }));
	const port2 = await listen(server2);
	assert.equal((await fetch(`http://127.0.0.1:${port2}/healthz`)).status, 200);
	server2.close();
});

test('an unknown host is a 404 — there is no splitHost fallback', async () => {
	const server = createIngressListener(baseDeps({ findRuleByHost: () => undefined }));
	const port = await listen(server);
	const res = await fetch(`http://127.0.0.1:${port}/ui`, { headers: { host: 'unknown.privos.link', 'cf-connecting-ip': '203.0.113.1' } });
	assert.equal(res.status, 404);
	server.close();
});

test('a suspended rule serves the suspended page without dialing a runtime node', async () => {
	const rule: IngressRule = { host: 'shop--acme.privos.link', appId: 'app-1', workspaceId: 'ws-1', nodes: ['10.88.0.11'], suspended: true };
	const server = createIngressListener(baseDeps({ findRuleByHost: () => rule }));
	const port = await listen(server);
	const res = await fetch(`http://127.0.0.1:${port}/ui`, { headers: { host: 'shop--acme.privos.link', 'cf-connecting-ip': '203.0.113.1' } });
	assert.equal(res.status, 503);
	server.close();
});

test('missing CF-Connecting-IP is rejected with 400 (client IP comes only from Cloudflare)', async () => {
	const rule: IngressRule = { host: 'shop--acme.privos.link', appId: 'app-1', workspaceId: 'ws-1', nodes: ['10.88.0.11'], suspended: false };
	const server = createIngressListener(baseDeps({ findRuleByHost: () => rule }));
	const port = await listen(server);
	const res = await fetch(`http://127.0.0.1:${port}/ui`, { headers: { host: 'shop--acme.privos.link' } });
	assert.equal(res.status, 400);
	server.close();
});

test('forwards to the runtime node with the original Host, a fresh signature, and CF-Connecting-IP only — client X-Forwarded-For dropped', async () => {
	const runtime = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end(JSON.stringify({
			host: req.headers.host,
			hasSig: Boolean(req.headers['x-privos-sig']),
			targetNode: req.headers['x-privos-target-node'],
			clientIp: req.headers['x-privos-client-ip'],
		}));
	});
	const rport = await listen(runtime);

	const rule: IngressRule = { host: 'shop--acme.privos.link', appId: 'app-1', workspaceId: 'ws-1', nodes: ['127.0.0.1'], suspended: false };
	const server = createIngressListener(baseDeps({ findRuleByHost: () => rule, runtimeProxyPort: rport, selfMeshIp: undefined }));
	const port = await listen(server);

	const res = await requestWithHost(port, '/ui', { host: 'shop--acme.privos.link', 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': 'spoofed' });
	assert.equal(res.status, 200);
	const body = (await res.json()) as { host: string; hasSig: boolean; targetNode: string; clientIp: string };
	assert.equal(body.host, 'shop--acme.privos.link');
	assert.equal(body.hasSig, true);
	assert.equal(body.targetNode, '127.0.0.1');
	assert.equal(body.clientIp, '203.0.113.7');

	server.close();
	runtime.close();
});

test('prefers the local mesh IP (BOTH role shortcut) among the rule replicas', async () => {
	const local = http.createServer((_req, res) => { res.writeHead(200); res.end('local'); });
	const remote = http.createServer((_req, res) => { res.writeHead(200); res.end('remote'); });
	const lport = await listen(local);
	const rport = await listen(remote);

	const rule: IngressRule = { host: 'shop--acme.privos.link', appId: 'app-1', workspaceId: 'ws-1', nodes: ['127.0.0.1', '127.0.0.2'], suspended: false };
	// selfMeshIp matches the first replica's address family here via runtimeProxyPort shared with `local`.
	const server = createIngressListener(baseDeps({ findRuleByHost: () => rule, runtimeProxyPort: lport, selfMeshIp: '127.0.0.1' }));
	const port = await listen(server);

	const res = await fetch(`http://127.0.0.1:${port}/ui`, { headers: { host: 'shop--acme.privos.link', 'cf-connecting-ip': '203.0.113.7' } });
	assert.equal(await res.text(), 'local');

	server.close();
	local.close();
	remote.close();
});

// The two mesh "nodes" below are two loopback ADDRESSES (127.0.0.1 / 127.0.0.2)
// sharing one PORT, so a single `runtimeProxyPort` in deps can address either.

test('retries the next replica on a runtime 404 unknown-host', async () => {
	const unknown = http.createServer((_req, res) => {
		res.writeHead(404, { 'x-privos-error': 'unknown-host' });
		res.end('404 Not Found');
	});
	const unknownPort = await listen(unknown);

	const known = http.createServer((_req, res) => { res.writeHead(200); res.end('ok-from-second'); });
	const knownPort = await listen(known);

	// Two logical mesh IPs, both dialed on 127.0.0.1 via `dialTarget` — avoids
	// depending on a real 127.0.0.2 loopback alias, which macOS doesn't bind by default.
	const rule: IngressRule = { host: 'shop--acme.privos.link', appId: 'app-1', workspaceId: 'ws-1', nodes: ['127.0.0.1', '127.0.0.2'], suspended: false };
	const server = createIngressListener(baseDeps({
		findRuleByHost: () => rule,
		runtimeProxyPort: unknownPort,
		selfMeshIp: undefined,
		dialTarget: (ip) => ({ host: '127.0.0.1', port: ip === '127.0.0.1' ? unknownPort : knownPort }),
	}));
	const sport = await listen(server);

	const res = await fetch(`http://127.0.0.1:${sport}/ui`, { headers: { host: 'shop--acme.privos.link', 'cf-connecting-ip': '203.0.113.7' } });
	assert.equal(res.status, 200);
	assert.equal(await res.text(), 'ok-from-second');

	server.close();
	unknown.close();
	known.close();
});

test('retries the next replica on a pre-connection error (first node unreachable)', async () => {
	const known = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
	const knownPort = await listen(known);
	const unreachablePort = await unusedPort(); // nothing listens here — a genuine connection-refused, not an app-level 404

	const rule: IngressRule = { host: 'shop--acme.privos.link', appId: 'app-1', workspaceId: 'ws-1', nodes: ['127.0.0.1', '127.0.0.2'], suspended: false };
	const server = createIngressListener(baseDeps({
		findRuleByHost: () => rule,
		runtimeProxyPort: unreachablePort,
		selfMeshIp: undefined,
		dialTarget: (ip) => ({ host: '127.0.0.1', port: ip === '127.0.0.1' ? unreachablePort : knownPort }),
	}));
	const sport = await listen(server);

	const res = await fetch(`http://127.0.0.1:${sport}/ui`, { headers: { host: 'shop--acme.privos.link', 'cf-connecting-ip': '203.0.113.7' } });
	assert.equal(res.status, 200);
	assert.equal(await res.text(), 'ok');

	server.close();
	known.close();
});

test('a request with a body is attempted at most once — a streamed body is never re-sent', async () => {
	let attempts = 0;
	const firstNode = http.createServer((_req, res) => {
		attempts++;
		res.writeHead(404, { 'x-privos-error': 'unknown-host' });
		res.end('404 Not Found');
	});
	const firstPort = await listen(firstNode);

	const secondNode = http.createServer((_req, res) => { res.writeHead(200); res.end('should never be reached for a POST'); });
	const secondPort = await listen(secondNode);

	const rule: IngressRule = { host: 'shop--acme.privos.link', appId: 'app-1', workspaceId: 'ws-1', nodes: ['127.0.0.1', '127.0.0.2'], suspended: false };
	const server = createIngressListener(baseDeps({
		findRuleByHost: () => rule,
		runtimeProxyPort: firstPort,
		selfMeshIp: undefined,
		dialTarget: (ip) => ({ host: '127.0.0.1', port: ip === '127.0.0.1' ? firstPort : secondPort }),
	}));
	const sport = await listen(server);

	const res = await fetch(`http://127.0.0.1:${sport}/ui`, {
		method: 'POST', body: 'hello',
		headers: { host: 'shop--acme.privos.link', 'cf-connecting-ip': '203.0.113.7' },
	});
	assert.equal(res.status, 404, 'the retry is skipped once the body has been handed to a node, even though it was an unknown-host 404');
	assert.equal(attempts, 1);

	server.close();
	firstNode.close();
	secondNode.close();
});

test('forwards a WebSocket upgrade to the runtime node', async () => {
	const runtime = http.createServer();
	runtime.on('upgrade', (_req, socket) => {
		socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
		socket.on('data', (d) => socket.write(d));
	});
	const rport = await listen(runtime);
	const rule: IngressRule = { host: 'shop--acme.privos.link', appId: 'app-1', workspaceId: 'ws-1', nodes: ['127.0.0.1'], suspended: false };
	const server = createIngressListener(baseDeps({ findRuleByHost: () => rule, runtimeProxyPort: rport, selfMeshIp: undefined }));
	const port = await listen(server);

	const client = net.connect(port, '127.0.0.1');
	const done = new Promise<boolean>((resolve) => {
		let sawSwitch = false;
		let buf = '';
		client.on('data', (d) => {
			buf += d.toString();
			if (!sawSwitch && buf.includes('101 Switching Protocols')) {
				sawSwitch = true;
				buf = '';
				client.write('ping');
			} else if (sawSwitch && buf.includes('ping')) {
				resolve(true);
			}
		});
	});
	client.write(
		'GET /ws HTTP/1.1\r\nHost: shop--acme.privos.link\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
			'Sec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\nCF-Connecting-IP: 203.0.113.7\r\n\r\n',
	);

	assert.equal(await done, true);
	client.destroy();
	server.close();
	runtime.close();
});
