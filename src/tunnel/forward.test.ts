import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dispatchForward, type ForwardTransport } from './forward.js';

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
	const hugeBody = { data: 'x'.repeat(70 * 1024) };
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
