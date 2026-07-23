import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';

import { createProxyServer } from './reverse-proxy-server.js';
import type { Router, ResolvedTarget } from './proxy-router.js';

async function listen(server: http.Server): Promise<number> {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return (server.address() as net.AddressInfo).port;
}

function fixedRouter(target: ResolvedTarget | null): Router {
	return { resolve: async () => target, refreshRoutes() {} };
}

test('proxy streams an HTTP response and injects X-Forwarded-Proto=https', async () => {
	const upstream = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end(`ok proto=${req.headers['x-forwarded-proto']} path=${req.url}`);
	});
	const uport = await listen(upstream);
	const proxy = createProxyServer(fixedRouter({ url: `http://127.0.0.1:${uport}`, containerId: 'c' }));
	const pport = await listen(proxy);

	const res = await fetch(`http://127.0.0.1:${pport}/hello?x=1`);
	assert.equal(res.status, 200);
	assert.equal(await res.text(), 'ok proto=https path=/hello?x=1');

	proxy.close();
	upstream.close();
});

test('proxy returns 502 when no backend resolves', async () => {
	const proxy = createProxyServer(fixedRouter(null));
	const pport = await listen(proxy);

	const res = await fetch(`http://127.0.0.1:${pport}/nope`);
	assert.equal(res.status, 502);

	proxy.close();
});

test('proxy passes a websocket upgrade through bidirectionally', async () => {
	const upstream = http.createServer();
	upstream.on('upgrade', (_req, socket) => {
		socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
		socket.on('data', (d) => socket.write(d)); // echo
	});
	const uport = await listen(upstream);
	const proxy = createProxyServer(fixedRouter({ url: `http://127.0.0.1:${uport}`, containerId: 'c' }));
	const pport = await listen(proxy);

	const client = net.connect(pport, '127.0.0.1');
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
		'GET /ws HTTP/1.1\r\nHost: whoami.privos.link\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
			'Sec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
	);

	assert.equal(await done, true);
	client.destroy();
	proxy.close();
	upstream.close();
});
