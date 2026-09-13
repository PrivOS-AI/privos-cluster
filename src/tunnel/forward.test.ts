import assert from 'node:assert/strict';
import { test } from 'node:test';

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { FORWARD_BODY_MAX_BYTES, dispatchForward, type ForwardTransport } from './forward.js';
import { MAX_JSON_FRAME_BYTES, encodeFrame } from './frames.js';

const RUNTIME_ID = 'local-runtime-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function fakeDocker(containers: any[]) {
	return {
		listContainers: async (opts: { filters?: { label?: string[] } }) => {
			const labelFilter = opts.filters?.label?.[0];
			if (!labelFilter) return containers;
			const [key, value] = labelFilter.split('=');
			return containers.filter((c) => c.Labels?.[key!] === value);
		},
	} as any;
}

function runningContainer(runtimeId: string, address = '10.99.0.7', port = 3001): any {
	return {
		Labels: { 'privos.local-runtime.id': runtimeId },
		NetworkSettings: { Networks: { 'privos-local-runtime': { IPAddress: address } } },
		Ports: [{ PrivatePort: port }],
	};
}

test('reaches only the container carrying the matching privos.local-runtime.id label', async () => {
	const docker = fakeDocker([runningContainer(RUNTIME_ID)]);
	const calls: string[] = [];
	const transport: ForwardTransport = async (url) => {
		calls.push(url);
		return { status: 200, bodyText: JSON.stringify({ ok: true }) };
	};
	const result = await dispatchForward(docker, { runtimeId: RUNTIME_ID, path: '/mcp', body: { jsonrpc: '2.0' } }, transport);
	assert.equal(result.status, 200);
	assert.deepEqual(result.body, { ok: true });
	assert.equal(calls.length, 1);
	assert.equal(calls[0], 'http://10.99.0.7:3001/mcp');
});

test('the tunnel frame carries only the 32-hex part and still resolves the container labelled with the full driver id', async () => {
	const hex = RUNTIME_ID.slice('local-runtime-'.length);
	const docker = fakeDocker([runningContainer(RUNTIME_ID)]);
	const calls: string[] = [];
	const transport: ForwardTransport = async (url) => {
		calls.push(url);
		return { status: 200, bodyText: '{}' };
	};
	const result = await dispatchForward(docker, { runtimeId: hex, path: '/mcp', body: { jsonrpc: '2.0' } }, transport);
	assert.equal(result.status, 200);
	assert.equal(calls.length, 1);
});

test('a body-less upstream reply is status-only, never raw with an empty rawBody', async () => {
	const docker = fakeDocker([runningContainer(RUNTIME_ID)]);
	const transport: ForwardTransport = async () => ({ status: 202, bodyText: '' });
	const result = await dispatchForward(docker, { runtimeId: RUNTIME_ID, path: '/mcp', body: { jsonrpc: '2.0', method: 'notifications/initialized' } }, transport);
	assert.deepEqual(result, { status: 202 });
});

test('an unknown runtimeId returns 404 without invoking the HTTP transport', async () => {
	const docker = fakeDocker([runningContainer(RUNTIME_ID)]);
	let transportCalled = false;
	const transport: ForwardTransport = async () => {
		transportCalled = true;
		return { status: 200, bodyText: '{}' };
	};
	const otherRuntimeId = 'local-runtime-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
	const result = await dispatchForward(docker, { runtimeId: otherRuntimeId, path: '/mcp' }, transport);
	assert.equal(result.status, 404);
	assert.equal(result.error?.code, 'not_found');
	assert.equal(transportCalled, false);
});

test('a caller-supplied runtimeId never selects a different container by coincidence — exact label match only', async () => {
	const decoyId = 'local-runtime-cccccccccccccccccccccccccccccccc';
	const docker = fakeDocker([runningContainer(RUNTIME_ID), runningContainer(decoyId, '10.99.0.8', 4001)]);
	const transport: ForwardTransport = async (url) => ({ status: 200, bodyText: JSON.stringify({ url }) });
	const result = await dispatchForward(docker, { runtimeId: decoyId, path: '/mcp' }, transport);
	assert.deepEqual(result.body, { url: 'http://10.99.0.8:4001/mcp' });
});

test('GET is used when no body is present, POST when a body is present', async () => {
	const docker = fakeDocker([runningContainer(RUNTIME_ID)]);
	const methods: string[] = [];
	const transport: ForwardTransport = async (_url, init) => {
		methods.push(init.method);
		return { status: 200, bodyText: '{}' };
	};
	await dispatchForward(docker, { runtimeId: RUNTIME_ID, path: '/mcp' }, transport);
	await dispatchForward(docker, { runtimeId: RUNTIME_ID, path: '/mcp', body: { a: 1 } }, transport);
	assert.deepEqual(methods, ['GET', 'POST']);
});

test('a non-JSON upstream response is passed through as raw/rawBody', async () => {
	const docker = fakeDocker([runningContainer(RUNTIME_ID)]);
	const transport: ForwardTransport = async () => ({ status: 200, bodyText: 'not json' });
	const result = await dispatchForward(docker, { runtimeId: RUNTIME_ID, path: '/mcp' }, transport);
	assert.equal(result.raw, true);
	assert.equal(result.rawBody, 'not json');
});

test('an oversized request body is refused with 413 before the transport is invoked', async () => {
	const docker = fakeDocker([runningContainer(RUNTIME_ID)]);
	let transportCalled = false;
	const transport: ForwardTransport = async () => { transportCalled = true; return { status: 200, bodyText: '{}' }; };
	const hugeBody = { data: 'x'.repeat(FORWARD_BODY_MAX_BYTES) };
	const result = await dispatchForward(docker, { runtimeId: RUNTIME_ID, path: '/mcp', body: hugeBody }, transport);
	assert.equal(result.status, 413);
	assert.equal(transportCalled, false);
});

test('a non-absolute path is refused with 400 without any Docker lookup', async () => {
	let listCalled = false;
	const docker = { listContainers: async () => { listCalled = true; return []; } } as any;
	const result = await dispatchForward(docker, { runtimeId: RUNTIME_ID, path: 'mcp' }, async () => ({ status: 200, bodyText: '{}' }));
	assert.equal(result.status, 400);
	assert.equal(listCalled, false);
});

test('a transport failure maps to a 502 res body instead of throwing out of dispatchForward', async () => {
	const docker = fakeDocker([runningContainer(RUNTIME_ID)]);
	const transport: ForwardTransport = async () => { throw new Error('connect refused'); };
	const result = await dispatchForward(docker, { runtimeId: RUNTIME_ID, path: '/mcp' }, transport);
	assert.equal(result.status, 502);
	assert.equal(result.error?.code, 'forward_failed');
});

/** A real upstream over loopback so the default (undici) transport's response cap is what gets exercised. */
async function withUpstream(bodyText: string, run: (port: number) => Promise<void>): Promise<void> {
	const server = http.createServer((_req, res) => {
		res.setHeader('content-type', 'application/json');
		res.end(bodyText);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		await run((server.address() as AddressInfo).port);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

// The demo's largest UI asset is a 149 KB vendor chunk, read through this
// path as a `resources/read` result; the previous 64 KB cap cut it off. The
// reply must also still fit the tunnel frame it rides in.
test('an asset-sized JSON reply passes the response cap and its res frame fits the tunnel JSON frame cap', async () => {
	const reply = JSON.stringify({ jsonrpc: '2.0', id: 3, result: { contents: [{ uri: 'ui://app/assets/vendor.js', mimeType: 'text/javascript', text: 'v'.repeat(600 * 1024) }] } });
	await withUpstream(reply, async (port) => {
		const docker = fakeDocker([runningContainer(RUNTIME_ID, '127.0.0.1', port)]);
		const result = await dispatchForward(docker, { runtimeId: RUNTIME_ID, path: '/mcp', body: { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'ui://app/assets/vendor.js' } } });
		assert.equal(result.status, 200);
		assert.deepEqual(result.body, JSON.parse(reply));
		const frame = encodeFrame({ t: 'res', id: 'f1', status: result.status, body: result.body });
		assert.ok(Buffer.byteLength(frame, 'utf8') <= MAX_JSON_FRAME_BYTES);
	});
});

test('a reply above the cap is refused as 502 response_too_large instead of an unencodable frame', async () => {
	await withUpstream(JSON.stringify({ data: 'x'.repeat(FORWARD_BODY_MAX_BYTES) }), async (port) => {
		const docker = fakeDocker([runningContainer(RUNTIME_ID, '127.0.0.1', port)]);
		const result = await dispatchForward(docker, { runtimeId: RUNTIME_ID, path: '/mcp', body: { jsonrpc: '2.0', id: 4, method: 'resources/read' } });
		assert.equal(result.status, 502);
		assert.equal(result.error?.code, 'response_too_large');
	});
});
