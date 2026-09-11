import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import jwt from 'jsonwebtoken';

import { CREDENTIAL_FILENAME, PAIR_TOKEN_FILENAME, readStateFile, writeStateFile } from '../state-dir.js';
import { TunnelClient, type TunnelClientOptions, type TunnelSocket } from './tunnel-client.js';
import { handleRepairRequiredClose, runCommunityBootstrap, type BootstrapFetchFn, type BootstrapFetchResponse } from './pairing.js';

// Minimal in-process fake — no test in this file opens a real socket or a real
// network connection. Scoped to this file: `tunnel-client.test.ts` owns the
// fuller req/forward/staging harness; this one only needs open/close/message/send
// for the redeem-flow integration tests below.
class FakeSocket extends EventEmitter implements TunnelSocket {
	readyState = 1; // OPEN
	sent: (string | Buffer)[] = [];
	closedWith: { code?: number; reason?: string } | undefined;
	headers: Record<string, string> = {};

	send(data: string | Buffer): void {
		this.sent.push(data);
	}

	close(code?: number, reason?: string): void {
		if (this.closedWith) return; // idempotent, like a real socket
		this.closedWith = { code, reason };
		this.readyState = 3; // CLOSED
		this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
	}
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

let tmpDirs: string[] = [];
function makeTmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privos-pairing-test-'));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
	tmpDirs = [];
	delete process.env.PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN;
});

function makeClient(stateDir: string, sockets: FakeSocket[], overrides: Partial<TunnelClientOptions> = {}): TunnelClient {
	return new TunnelClient({
		hubUrl: 'https://hub.example.com',
		clusterId: 'cl_test',
		version: '1.2.3',
		stateDir,
		clusterCapabilities: { operatorRoutes: false, artifactStaging: true },
		fastify: {
			inject: async () => ({ statusCode: 200, body: '{}', headers: {}, json: () => ({}) }) as never,
			log: silentLogger,
		},
		// Fresh per-request resolution, same as production `resolveClusterSecret()` — a
		// credential written (or deleted) after boot takes effect with no restart.
		resolveSecret: () => readStateFile(stateDir, CREDENTIAL_FILENAME)?.trim(),
		createSocket: (_url, headers) => {
			const socket = new FakeSocket();
			socket.headers = headers;
			sockets.push(socket);
			return socket;
		},
		random: () => 0,
		...overrides,
	});
}

describe('paired-frame redemption (tunnel-client.ts integration)', () => {
	test('persists the credential, reconnects with a connect JWT, and never resends the consumed pair token', async () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, PAIR_TOKEN_FILENAME, 'one-time-token');
		const sockets: FakeSocket[] = [];
		const client = makeClient(stateDir, sockets);

		client.start();
		assert.equal(sockets[0].headers['X-Privos-Pair-Token'], 'one-time-token');
		assert.equal(sockets[0].headers.Authorization, undefined);

		sockets[0].emit('message', JSON.stringify({ t: 'paired', clusterId: 'cl_test', credential: 'new-cred-0123456789' }), false);
		assert.equal(readStateFile(stateDir, CREDENTIAL_FILENAME), 'new-cred-0123456789');
		assert.equal(readStateFile(stateDir, PAIR_TOKEN_FILENAME), undefined, 'consumed token removed immediately, before any reconnect');

		// Hub closes the socket once `paired` is sent (wire-contracts.md) — simulate and reconnect.
		sockets[0].close(1000, 'paired');
		await new Promise((resolve) => setTimeout(resolve, 10));

		assert.equal(sockets.length, 2, 'reconnects automatically');
		assert.equal(sockets[1].headers['X-Privos-Pair-Token'], undefined, 'the consumed one-time token is never retried');
		const auth = sockets[1].headers.Authorization;
		assert.ok(auth?.startsWith('Bearer '), 'reconnects with a connect JWT instead');
		const decoded = jwt.verify(auth!.slice('Bearer '.length), 'new-cred-0123456789') as jwt.JwtPayload;
		assert.equal(decoded.iss, 'privos-app-cluster');

		client.stop();
	});
});

describe('re-pair required terminal state (tunnel-client.ts integration)', () => {
	test('a 4403 revoked close with no pair token deletes the dead credential, logs the reason, and keeps reconnecting credential-less', async () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, CREDENTIAL_FILENAME, 'now-revoked-credential');
		const sockets: FakeSocket[] = [];
		const warnings: unknown[] = [];
		const client = makeClient(stateDir, sockets, {
			fastify: {
				inject: async () => ({ statusCode: 200, body: '{}', headers: {}, json: () => ({}) }) as never,
				log: { info: () => {}, warn: (...args: unknown[]) => warnings.push(args), error: () => {} },
			},
		});

		client.start();
		assert.ok(sockets[0].headers.Authorization?.startsWith('Bearer '));

		sockets[0].close(4403, 'revoked');
		await new Promise((resolve) => setTimeout(resolve, 10));

		assert.equal(readStateFile(stateDir, CREDENTIAL_FILENAME), undefined, 'dead credential removed so it is never resent');
		assert.equal(sockets.length, 2, 'still retries — a fresh re-pair needs no process restart');
		assert.deepEqual(sockets[1].headers, {}, 'reconnects with no auth headers, never the dead credential');
		assert.ok(
			warnings.some((args) => JSON.stringify(args).includes('revoked')),
			'terminal state is logged distinctly from an ordinary disconnect',
		);

		client.stop();
	});

	test('an ordinary transient close (e.g. handshake timeout) keeps the credential and retries normally', async () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, CREDENTIAL_FILENAME, 'still-good-credential');
		const sockets: FakeSocket[] = [];
		const client = makeClient(stateDir, sockets);

		client.start();
		sockets[0].close(4408, 'handshake_timeout');
		await new Promise((resolve) => setTimeout(resolve, 10));

		assert.equal(readStateFile(stateDir, CREDENTIAL_FILENAME), 'still-good-credential');
		assert.equal(sockets.length, 2);
		assert.ok(sockets[1].headers.Authorization?.startsWith('Bearer '), 'reconnects with the same still-valid credential');

		client.stop();
	});
});

describe('handleRepairRequiredClose', () => {
	test('4403 revoked with no pair token: terminal — deletes the dead credential', () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, CREDENTIAL_FILENAME, 'dead-credential');
		assert.equal(handleRepairRequiredClose(stateDir, 4403, false), 'revoked');
		assert.equal(readStateFile(stateDir, CREDENTIAL_FILENAME), undefined);
	});

	test('4401 unauthorized with no pair token: same terminal treatment', () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, CREDENTIAL_FILENAME, 'dead-credential');
		assert.equal(handleRepairRequiredClose(stateDir, 4401, false), 'unauthorized');
		assert.equal(readStateFile(stateDir, CREDENTIAL_FILENAME), undefined);
	});

	test('an auth-failure close while a pair token still exists is not terminal (the token has not been tried yet)', () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, CREDENTIAL_FILENAME, 'still-there');
		assert.equal(handleRepairRequiredClose(stateDir, 4401, true), undefined);
		assert.equal(readStateFile(stateDir, CREDENTIAL_FILENAME), 'still-there');
	});

	test('an ordinary close code (e.g. 4408 handshake_timeout) is never terminal', () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, CREDENTIAL_FILENAME, 'still-there');
		assert.equal(handleRepairRequiredClose(stateDir, 4408, false), undefined);
		assert.equal(readStateFile(stateDir, CREDENTIAL_FILENAME), 'still-there');
	});
});

describe('runCommunityBootstrap', () => {
	const BOOTSTRAP_TOKEN = 'shared-bootstrap-token-0123456789';

	test('mutual HMAC success: verifies the hub proof and persists the redeemed pair token', async () => {
		const stateDir = makeTmpDir();
		let capturedBody: { clusterNonce: string; clusterProof: string } | undefined;
		const fetchImpl: BootstrapFetchFn = async (_url, init) => {
			capturedBody = JSON.parse(init.body as string);
			const hubNonce = 'hub-nonce-fixed';
			const hubProof = createHmac('sha256', BOOTSTRAP_TOKEN).update(`hub:${capturedBody!.clusterNonce}:${hubNonce}`).digest('hex');
			const response: BootstrapFetchResponse = {
				json: async () => ({ ok: true, clusterId: 'cl_bootstrap', hubNonce, hubProof, token: 'redeemed-pair-token', expiresAt: 1_700_000_000_000 }),
			};
			return response;
		};

		const result = await runCommunityBootstrap({ hubUrl: 'http://hub:3000', bootstrapToken: BOOTSTRAP_TOKEN, stateDir, fetchImpl, nonce: () => 'client-nonce-fixed' });

		assert.deepEqual(result, { ok: true, clusterId: 'cl_bootstrap', expiresAt: 1_700_000_000_000 });
		assert.equal(readStateFile(stateDir, PAIR_TOKEN_FILENAME), 'redeemed-pair-token');
		assert.equal(capturedBody?.clusterNonce, 'client-nonce-fixed');
		assert.equal(capturedBody?.clusterProof, createHmac('sha256', BOOTSTRAP_TOKEN).update('client:client-nonce-fixed').digest('hex'));
	});

	test('abort-on-failed-challenge: a peer that cannot answer the HMAC challenge is refused before any credential is accepted', async () => {
		const stateDir = makeTmpDir();
		const fetchImpl: BootstrapFetchFn = async () => ({
			json: async () => ({
				ok: true,
				clusterId: 'cl_bootstrap',
				hubNonce: 'hub-nonce-fixed',
				hubProof: 'deadbeef'.repeat(8), // not derived from BOOTSTRAP_TOKEN — the peer does not know it
				token: 'should-never-be-written',
				expiresAt: 1_700_000_000_000,
			}),
		});

		const result = await runCommunityBootstrap({ hubUrl: 'http://hub:3000', bootstrapToken: BOOTSTRAP_TOKEN, stateDir, fetchImpl, nonce: () => 'client-nonce-fixed' });

		assert.deepEqual(result, { ok: false, reason: 'invalid_hub_proof' });
		assert.equal(readStateFile(stateDir, PAIR_TOKEN_FILENAME), undefined, 'no pair token is ever persisted when the hub proof does not verify');
	});

	test('a Hub-reported failure (ok:false, e.g. already-burned seed) is surfaced and nothing is persisted', async () => {
		const stateDir = makeTmpDir();
		const fetchImpl: BootstrapFetchFn = async () => ({ json: async () => ({ ok: false, reason: 'already_burned' }) });

		const result = await runCommunityBootstrap({ hubUrl: 'http://hub:3000', bootstrapToken: BOOTSTRAP_TOKEN, stateDir, fetchImpl });

		assert.deepEqual(result, { ok: false, reason: 'already_burned' });
		assert.equal(readStateFile(stateDir, PAIR_TOKEN_FILENAME), undefined);
	});

	test('a malformed/non-JSON response is refused as invalid_response, nothing persisted', async () => {
		const stateDir = makeTmpDir();
		const fetchImpl: BootstrapFetchFn = async () => ({
			json: async () => {
				throw new Error('not json');
			},
		});

		const result = await runCommunityBootstrap({ hubUrl: 'http://hub:3000', bootstrapToken: BOOTSTRAP_TOKEN, stateDir, fetchImpl });

		assert.deepEqual(result, { ok: false, reason: 'invalid_response' });
		assert.equal(readStateFile(stateDir, PAIR_TOKEN_FILENAME), undefined);
	});

	test('a network error is refused as request_failed, nothing persisted', async () => {
		const stateDir = makeTmpDir();
		const fetchImpl: BootstrapFetchFn = async () => {
			throw new Error('ECONNREFUSED');
		};

		const result = await runCommunityBootstrap({ hubUrl: 'http://hub:3000', bootstrapToken: BOOTSTRAP_TOKEN, stateDir, fetchImpl });

		assert.deepEqual(result, { ok: false, reason: 'request_failed' });
	});

	test('not configured: a blank bootstrap token is refused with no network call', async () => {
		const stateDir = makeTmpDir();
		let called = false;
		const fetchImpl: BootstrapFetchFn = async () => {
			called = true;
			return { json: async () => ({}) };
		};

		const result = await runCommunityBootstrap({ hubUrl: 'http://hub:3000', bootstrapToken: '   ', stateDir, fetchImpl });

		assert.deepEqual(result, { ok: false, reason: 'not_configured' });
		assert.equal(called, false);
	});
});
