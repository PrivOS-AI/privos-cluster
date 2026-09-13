import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import jwt from 'jsonwebtoken';

import { CLUSTER_ID_FILENAME, CREDENTIAL_FILENAME, PAIR_TOKEN_FILENAME, readStateFile, writeStateFile } from '../state-dir.js';
import { MAX_CHUNK_BYTES } from './frames.js';
import {
	BACKOFF_CAP_MS,
	DEFAULT_CONCURRENCY_LIMIT,
	TunnelClient,
	fullJitterBackoffMs,
	type StagedArtifact,
	type TunnelClientOptions,
	type TunnelSocket,
} from './tunnel-client.js';

// No test in this file opens a real network socket — `createSocket` is
// always overridden with this in-process EventEmitter fake, which satisfies
// the same minimal `TunnelSocket` surface `ws` does.
class FakeSocket extends EventEmitter implements TunnelSocket {
	readyState = 1; // OPEN
	sent: (string | Buffer)[] = [];
	closedWith: { code?: number; reason?: string } | undefined;

	send(data: string | Buffer): void {
		this.sent.push(data);
	}

	close(code?: number, reason?: string): void {
		if (this.closedWith) return; // idempotent, like a real socket
		this.closedWith = { code, reason };
		this.readyState = 3; // CLOSED
		this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
	}

	lastFrame(): Record<string, unknown> {
		const last = this.sent.at(-1);
		if (typeof last !== 'string') throw new Error('last sent message was not a text frame');
		return JSON.parse(last) as Record<string, unknown>;
	}
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

async function flush(): Promise<void> {
	// Two microtask turns is enough to drain the single `await inject()` chain
	// used throughout `handleReq`/`finalizeStage`.
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

let tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privos-tunnel-client-test-'));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
	tmpDirs = [];
});

interface Harness {
	client: TunnelClient;
	sockets: FakeSocket[];
	stateDir: string;
	openFirst(): FakeSocket;
}

function makeHarness(overrides: Partial<TunnelClientOptions> = {}): Harness {
	const stateDir = overrides.stateDir ?? makeTmpDir();
	const sockets: FakeSocket[] = [];
	const client = new TunnelClient({
		hubUrl: 'https://hub.example.com',
		clusterId: 'cl_test',
		version: '1.2.3',
		stateDir,
		clusterCapabilities: { operatorRoutes: false, artifactStaging: true },
		// Explicit, not a default: production must wire the real store (a silent
		// no-op there discarded every staged artifact).
		artifactStore: async () => {},
		fastify: {
			inject: async () => ({ statusCode: 200, body: '{}', headers: {}, json: () => ({}) }) as never,
			log: silentLogger,
		},
		resolveSecret: () => 'shared-cluster-secret-0123456789',
		createSocket: (_url, _headers) => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		random: () => 0,
		...overrides,
	});
	return {
		client,
		sockets,
		stateDir,
		openFirst(): FakeSocket {
			client.start();
			const socket = sockets[0];
			socket.emit('open');
			socket.sent.length = 0; // drop the `hello` frame for tests that don't care about it
			return socket;
		},
	};
}

describe('fullJitterBackoffMs', () => {
	test('stays within [0, min(cap, base*2^attempt)]', () => {
		for (const attempt of [0, 1, 2, 3, 10]) {
			const expectedMax = Math.min(BACKOFF_CAP_MS, 1000 * 2 ** attempt);
			assert.equal(fullJitterBackoffMs(attempt, () => 0), 0);
			assert.equal(fullJitterBackoffMs(attempt, () => 0.999999), Math.floor(0.999999 * expectedMax));
		}
	});

	test('caps at 30s regardless of how large the attempt count grows', () => {
		assert.equal(fullJitterBackoffMs(50, () => 1), BACKOFF_CAP_MS);
	});
});

describe('connect + hello', () => {
	test('sends {t:hello, version, clusterId, clusterCapabilities} on open', () => {
		const { client, sockets } = makeHarness();
		client.start();
		sockets[0].emit('open');
		assert.deepEqual(JSON.parse(sockets[0].sent[0] as string), {
			t: 'hello',
			version: '1.2.3',
			clusterId: 'cl_test',
			clusterCapabilities: { operatorRoutes: false, artifactStaging: true },
		});
		client.stop();
	});

	test('signs a connect JWT (iss/kid/jti/60s ttl) when a secret is resolved', () => {
		const sockets: { headers: Record<string, string> }[] = [];
		const { client } = makeHarness({
			createSocket: (_url, headers) => {
				sockets.push({ headers });
				return new FakeSocket();
			},
		});
		client.start();
		const auth = sockets[0].headers.Authorization;
		assert.ok(auth?.startsWith('Bearer '));
		const token = auth!.slice('Bearer '.length);
		const decoded = jwt.verify(token, 'shared-cluster-secret-0123456789') as jwt.JwtPayload;
		const header = jwt.decode(token, { complete: true })?.header;
		assert.equal(decoded.iss, 'privos-app-cluster');
		assert.equal(header?.kid, 'cl_test');
		assert.ok(decoded.jti);
		assert.ok(decoded.exp && decoded.iat && decoded.exp - decoded.iat === 60);
		client.stop();
	});

	test('falls back to the X-Privos-Pair-Token header when unpaired', () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, PAIR_TOKEN_FILENAME, 'one-time-token-value');
		const sockets: { headers: Record<string, string> }[] = [];
		const { client } = makeHarness({
			stateDir,
			resolveSecret: () => undefined,
			createSocket: (_url, headers) => {
				sockets.push({ headers });
				return new FakeSocket();
			},
		});
		client.start();
		assert.equal(sockets[0].headers['X-Privos-Pair-Token'], 'one-time-token-value');
		assert.equal(sockets[0].headers.Authorization, undefined);
		client.stop();
	});

	test('connects with no auth headers when neither a secret nor a pair token exists (dials and waits, no crash)', () => {
		const sockets: { headers: Record<string, string> }[] = [];
		const { client } = makeHarness({
			resolveSecret: () => undefined,
			createSocket: (_url, headers) => {
				sockets.push({ headers });
				return new FakeSocket();
			},
		});
		assert.doesNotThrow(() => client.start());
		assert.deepEqual(sockets[0].headers, {});
		client.stop();
	});
});

describe('req dispatch via fastify.inject', () => {
	test('maps an injected 200 JSON response to a matching res frame', async () => {
		const { client, sockets, openFirst } = makeHarness({
			fastify: {
				inject: async (opts) => {
					assert.equal(opts.method, 'GET');
					assert.equal(opts.url, '/api/v1/health');
					return { statusCode: 200, body: JSON.stringify({ status: 'ok', version: '0.1.0' }), headers: {}, json: () => ({ status: 'ok', version: '0.1.0' }) } as never;
				},
				log: silentLogger,
			},
		});
		const socket = openFirst();
		socket.emit('message', JSON.stringify({ t: 'req', id: 'req-1', method: 'GET', path: '/api/v1/health', timeoutMs: 15000 }), false);
		await flush();
		assert.deepEqual(socket.lastFrame(), { t: 'res', id: 'req-1', status: 200, body: { status: 'ok', version: '0.1.0' } });
		client.stop();
	});

	test('passes query params through to the injected url', async () => {
		let seenUrl = '';
		const { client, sockets, openFirst } = makeHarness({
			fastify: {
				inject: async (opts) => {
					seenUrl = opts.url as string;
					return { statusCode: 200, body: '{}', headers: {}, json: () => ({}) } as never;
				},
				log: silentLogger,
			},
		});
		const socket = openFirst();
		socket.emit('message', JSON.stringify({ t: 'req', id: 'req-2', method: 'POST', path: '/api/v1/deploy', query: { dryRun: 'true' }, timeoutMs: 15000 }), false);
		await flush();
		assert.equal(seenUrl, '/api/v1/deploy?dryRun=true');
		client.stop();
	});

	test('raw mode: rawBody passes through unmodified in both directions (driver-ABI never re-serializes)', async () => {
		const rawReqBody = '{"protocol_version":3,"operation":"ENSURE_READY"}';
		const rawResBody = '{"protocol_version":3,"state":"READY","runtime_id":"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"}';
		const { client, sockets, openFirst } = makeHarness({
			fastify: {
				inject: async (opts) => {
					assert.equal(opts.payload, rawReqBody);
					return { statusCode: 200, body: rawResBody, headers: {}, json: () => JSON.parse(rawResBody) } as never;
				},
				log: silentLogger,
			},
		});
		const socket = openFirst();
		socket.emit(
			'message',
			JSON.stringify({ t: 'req', id: 'req-3', method: 'PUT', path: '/api/v1/v3/runtimes/by-generation/gen-42', raw: true, rawBody: rawReqBody, timeoutMs: 30000 }),
			false,
		);
		await flush();
		assert.deepEqual(socket.lastFrame(), { t: 'res', id: 'req-3', status: 200, raw: true, rawBody: rawResBody });
		client.stop();
	});

	test('a thrown inject error maps to {status:500, body:{error:internal_error}}, never a stack', async () => {
		const { client, sockets, openFirst } = makeHarness({
			fastify: {
				inject: async () => {
					throw new Error('boom: something with an internal file path in it');
				},
				log: silentLogger,
			},
		});
		const socket = openFirst();
		socket.emit('message', JSON.stringify({ t: 'req', id: 'req-err', method: 'GET', path: '/x', timeoutMs: 1000 }), false);
		await flush();
		assert.deepEqual(socket.lastFrame(), { t: 'res', id: 'req-err', status: 500, body: { error: 'internal_error' } });
		client.stop();
	});

	test('concurrency cap: the (limit+1)th in-flight request gets 429, not unbounded memory', async () => {
		const releasers: Array<() => void> = [];
		const { client, sockets, openFirst } = makeHarness({
			fastify: {
				inject: () =>
					new Promise((resolve) => {
						releasers.push(() => resolve({ statusCode: 200, body: '{}', headers: {}, json: () => ({}) } as never));
					}),
				log: silentLogger,
			},
		});
		const socket = openFirst();
		for (let i = 0; i < DEFAULT_CONCURRENCY_LIMIT + 1; i++) {
			socket.emit('message', JSON.stringify({ t: 'req', id: `r${i}`, method: 'GET', path: '/x', timeoutMs: 1000 }), false);
		}
		await flush();
		const frames = socket.sent.map((s) => JSON.parse(s as string) as { id: string; status: number });
		const overflow = frames.find((f) => f.id === `r${DEFAULT_CONCURRENCY_LIMIT}`);
		assert.equal(overflow?.status, 429);
		assert.equal(frames.filter((f) => f.status === 200).length, 0); // the first 8 are still pending
		releasers.forEach((release) => release());
		await flush();
		const resolved = socket.sent.map((s) => JSON.parse(s as string) as { status: number }).filter((f) => f.status === 200);
		assert.equal(resolved.length, DEFAULT_CONCURRENCY_LIMIT);
		client.stop();
	});
});

describe('forward', () => {
	test('dispatches through the injected forwardDispatch seam and maps the result to a res frame', async () => {
		const calls: unknown[] = [];
		const { client, openFirst } = makeHarness({
			forwardDispatch: async (input) => {
				calls.push(input);
				return { status: 200, body: { ok: true } };
			},
		});
		const socket = openFirst();
		socket.emit('message', JSON.stringify({ t: 'forward', id: 'fwd-1', runtimeId: 'a'.repeat(32), path: '/mcp', body: { jsonrpc: '2.0' }, timeoutMs: 1000 }), false);
		await flush();
		const frame = socket.lastFrame();
		assert.equal(frame.status, 200);
		assert.deepEqual(frame.body, { ok: true });
		assert.deepEqual(calls, [{ runtimeId: 'a'.repeat(32), path: '/mcp', headers: undefined, body: { jsonrpc: '2.0' }, timeoutMs: 1000 }]);
		client.stop();
	});

	test('an unknown runtimeId (as reported by forwardDispatch) maps to a 404 res frame, no hang or crash', async () => {
		const { client, openFirst } = makeHarness({
			forwardDispatch: async () => ({ status: 404, error: { code: 'not_found', message: 'unknown runtimeId' } }),
		});
		const socket = openFirst();
		socket.emit('message', JSON.stringify({ t: 'forward', id: 'fwd-2', runtimeId: 'b'.repeat(32), path: '/mcp', timeoutMs: 1000 }), false);
		await flush();
		const frame = socket.lastFrame();
		assert.equal(frame.status, 404);
		assert.equal((frame.error as { code: string }).code, 'not_found');
		client.stop();
	});

	test('a thrown forwardDispatch error maps to a 500 res frame instead of crashing the tunnel', async () => {
		const { client, openFirst } = makeHarness({
			forwardDispatch: async () => { throw new Error('boom'); },
		});
		const socket = openFirst();
		socket.emit('message', JSON.stringify({ t: 'forward', id: 'fwd-3', runtimeId: 'c'.repeat(32), path: '/mcp', timeoutMs: 1000 }), false);
		await flush();
		const frame = socket.lastFrame();
		assert.equal(frame.status, 500);
		client.stop();
	});
});

describe('ping/pong liveness', () => {
	test('answers a ping with a pong echoing the same at', () => {
		const { client, openFirst } = makeHarness();
		const socket = openFirst();
		socket.emit('message', JSON.stringify({ t: 'ping', at: 1757600000000 }), false);
		assert.deepEqual(socket.lastFrame(), { t: 'pong', at: 1757600000000 });
		client.stop();
	});
});

describe('malformed frames', () => {
	test('closes the socket 4400 on malformed JSON', () => {
		const { client, openFirst } = makeHarness();
		const socket = openFirst();
		socket.emit('message', '{not json', false);
		assert.equal(socket.closedWith?.code, 4400);
		client.stop();
	});
});

describe('paired frame', () => {
	test('persists the credential and removes the one-time pair token', () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, PAIR_TOKEN_FILENAME, 'one-time-token');
		const { client, openFirst } = makeHarness({ stateDir });
		const socket = openFirst();
		socket.emit('message', JSON.stringify({ t: 'paired', clusterId: 'cl_test', credential: 'b64:new-credential' }), false);
		assert.equal(readStateFile(stateDir, CREDENTIAL_FILENAME), 'b64:new-credential');
		assert.equal(readStateFile(stateDir, PAIR_TOKEN_FILENAME), undefined);
		client.stop();
	});

	// The Hub keys a tunnel cluster by its own row id and resolves it from the
	// connect JWT's `kid`. Dropping the assigned id means every reconnect after a
	// successful pairing presents the local default and is refused 401 forever.
	test('persists the Hub-assigned cluster id', () => {
		const stateDir = makeTmpDir();
		const { client, openFirst } = makeHarness({ stateDir });
		const socket = openFirst();
		socket.emit('message', JSON.stringify({ t: 'paired', clusterId: 'hub-assigned-id', credential: 'b64:c' }), false);
		assert.equal(readStateFile(stateDir, CLUSTER_ID_FILENAME), 'hub-assigned-id');
		client.stop();
	});

	// The Hub compares the hello frame's clusterId against the cluster it resolved
	// from the connect JWT's kid, and closes 4401 on a mismatch. Both must use the
	// assigned id, so this covers the second site that read the local default.
	test('announces the Hub-assigned id in the hello frame', () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, CLUSTER_ID_FILENAME, 'hub-assigned-id');
		const { client, sockets } = makeHarness({ stateDir });
		client.start();
		sockets[0].emit('open'); // openFirst() drops the hello frame, which is the point here
		const hello = JSON.parse(sockets[0].sent[0] as string);
		assert.equal(hello.t, 'hello');
		assert.equal(hello.clusterId, 'hub-assigned-id');
		client.stop();
	});

	test('signs later connects with the Hub-assigned id, not the local default', () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, CLUSTER_ID_FILENAME, 'hub-assigned-id');
		const sockets: { headers: Record<string, string> }[] = [];
		const { client } = makeHarness({
			stateDir,
			createSocket: (_url, headers) => {
				sockets.push({ headers });
				return new FakeSocket();
			},
		});
		client.start();
		const token = sockets[0].headers.Authorization!.slice('Bearer '.length);
		assert.equal(jwt.decode(token, { complete: true })?.header.kid, 'hub-assigned-id');
		client.stop();
	});
});

describe('reconnect / backoff', () => {
	test('reconnects (creates a new socket) after the hub closes the connection, no process exit', async () => {
		const { client, sockets } = makeHarness({ random: () => 0 });
		client.start();
		sockets[0].emit('open');
		assert.equal(sockets.length, 1);
		sockets[0].emit('close', 4408, Buffer.from('handshake_timeout'));
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(sockets.length, 2);
		client.stop();
	});

	test('stop() prevents any further reconnect attempt', async () => {
		const { client, sockets } = makeHarness({ random: () => 0 });
		client.start();
		sockets[0].emit('open');
		client.stop();
		sockets[0].emit('close', 1000, Buffer.from('shutdown'));
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(sockets.length, 1);
	});
});

describe('req-chunk artifact staging (bypasses fastify.inject)', () => {
	test('streams chunks straight to a temp file with a rolling sha256, calls artifact-store, then deletes the temp file', async () => {
		const stored: StagedArtifact[] = [];
		const stateDir = makeTmpDir();
		const { client, openFirst } = makeHarness({
			stateDir,
			artifactStore: async (artifact) => {
				assert.ok(fs.existsSync(artifact.path), 'artifact-store must receive a real file path, not a buffer');
				stored.push(artifact);
			},
		});
		const socket = openFirst();
		const chunk1 = Buffer.from('hello ');
		const chunk2 = Buffer.from('world');
		socket.emit('message', JSON.stringify({ t: 'req-chunk', id: 'stage-7', seq: 0, byteLength: chunk1.byteLength, last: false }), false);
		socket.emit('message', chunk1, true);
		socket.emit('message', JSON.stringify({ t: 'req-chunk', id: 'stage-7', seq: 1, byteLength: chunk2.byteLength, last: true }), false);
		socket.emit('message', chunk2, true);
		await flush();
		assert.equal(stored.length, 1);
		assert.equal(stored[0].sizeBytes, chunk1.byteLength + chunk2.byteLength);
		assert.equal(stored[0].sha256, createHash('sha256').update(Buffer.concat([chunk1, chunk2])).digest('hex'));
		assert.ok(!fs.existsSync(stored[0].path), 'temp file must be deleted once artifact-store has consumed it');
		client.stop();
	});

	test('an oversized chunk closes the socket 4413 and discards the partial temp file', () => {
		const stateDir = makeTmpDir();
		const { client, openFirst } = makeHarness({ stateDir });
		const socket = openFirst();
		const oversized = Buffer.alloc(MAX_CHUNK_BYTES + 1);
		socket.emit('message', JSON.stringify({ t: 'req-chunk', id: 'stage-big', seq: 0, byteLength: oversized.byteLength, last: true }), false);
		socket.emit('message', oversized, true);
		assert.equal(socket.closedWith?.code, 4413);
		const stagingDir = path.join(stateDir, 'staging');
		assert.deepEqual(fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : [], []);
		client.stop();
	});

	test('a declared-vs-actual byteLength mismatch closes the socket 4413', () => {
		const { client, openFirst } = makeHarness();
		const socket = openFirst();
		const payload = Buffer.from('short');
		socket.emit('message', JSON.stringify({ t: 'req-chunk', id: 'stage-mismatch', seq: 0, byteLength: 999, last: true }), false);
		socket.emit('message', payload, true);
		assert.equal(socket.closedWith?.code, 4413);
		client.stop();
	});

	test('a disconnect mid-stage discards the partial temp file', () => {
		const stateDir = makeTmpDir();
		const { client, sockets, openFirst } = makeHarness({ stateDir, random: () => 0 });
		const socket = openFirst();
		const chunk = Buffer.from('partial');
		socket.emit('message', JSON.stringify({ t: 'req-chunk', id: 'stage-partial', seq: 0, byteLength: chunk.byteLength, last: false }), false);
		socket.emit('message', chunk, true);
		const stagingDir = path.join(stateDir, 'staging');
		assert.equal(fs.readdirSync(stagingDir).length, 1, 'temp file exists mid-stream');
		socket.emit('close', 1006, Buffer.from('abnormal'));
		assert.equal(fs.readdirSync(stagingDir).length, 0, 'partial file removed on disconnect');
		client.stop();
	});

	test('start() sweeps leftover staged-artifact temp files from a previous process run', () => {
		const stateDir = makeTmpDir();
		const stagingDir = path.join(stateDir, 'staging');
		fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(stagingDir, 'leftover.part'), 'unresumable partial data');
		const { client } = makeHarness({ stateDir });
		client.start();
		assert.deepEqual(fs.readdirSync(stagingDir), []);
		client.stop();
	});
});
