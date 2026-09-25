import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { generateNonce, signRequest, verifyRequest, loadOrCreateSigningIdentity, type SignedRequestFields } from './forward-signature.js';

function fields(overrides: Partial<SignedRequestFields> = {}): SignedRequestFields {
	return {
		targetNodeId: '10.88.0.11',
		nonce: generateNonce(),
		ts: 1_700_000_000_000,
		method: 'GET',
		host: 'shop--acme.privos.link',
		requestTarget: '/api/things?x=1',
		clientIp: '203.0.113.7',
		...overrides,
	};
}

async function tmpKeyPath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'privos-signing-key-'));
	return path.join(dir, 'ingress-signing-key.json');
}

test('sign then verify round-trips with the matching public key', async () => {
	const identity = await loadOrCreateSigningIdentity(await tmpKeyPath(), 'node-a');
	const f = fields();
	const sig = signRequest(f, identity.privateKey);
	assert.equal(verifyRequest(f, sig, identity.publicJwk), true);
});

test('verify rejects a tampered field (method, host, target, clientIp, ts, nonce)', async () => {
	const identity = await loadOrCreateSigningIdentity(await tmpKeyPath(), 'node-a');
	const f = fields();
	const sig = signRequest(f, identity.privateKey);
	assert.equal(verifyRequest({ ...f, method: 'POST' }, sig, identity.publicJwk), false);
	assert.equal(verifyRequest({ ...f, host: 'evil.privos.link' }, sig, identity.publicJwk), false);
	assert.equal(verifyRequest({ ...f, requestTarget: '/other' }, sig, identity.publicJwk), false);
	assert.equal(verifyRequest({ ...f, clientIp: '10.0.0.1' }, sig, identity.publicJwk), false);
	assert.equal(verifyRequest({ ...f, ts: f.ts + 1 }, sig, identity.publicJwk), false);
	assert.equal(verifyRequest({ ...f, nonce: generateNonce() }, sig, identity.publicJwk), false);
});

test('verify rejects a signature made with a different key', async () => {
	const identityA = await loadOrCreateSigningIdentity(await tmpKeyPath(), 'node-a');
	const identityB = await loadOrCreateSigningIdentity(await tmpKeyPath(), 'node-b');
	const f = fields();
	const sig = signRequest(f, identityA.privateKey);
	assert.equal(verifyRequest(f, sig, identityB.publicJwk), false);
});

test('verify never throws on garbage input', () => {
	assert.equal(verifyRequest(fields(), 'not-base64!!', { kty: 'OKP', crv: 'Ed25519', x: 'AA' }), false);
	assert.equal(verifyRequest(fields(), 'AAAA', {}), false);
});

test('loadOrCreateSigningIdentity persists the key and reloads the identical identity', async () => {
	const keyPath = await tmpKeyPath();
	const first = await loadOrCreateSigningIdentity(keyPath, 'node-a');
	const second = await loadOrCreateSigningIdentity(keyPath, 'node-a');
	assert.equal(second.kid, first.kid);
	assert.deepEqual(second.publicJwk, first.publicJwk);
});

test('loadOrCreateSigningIdentity rejects a key file stamped for a different node id', async () => {
	const keyPath = await tmpKeyPath();
	await loadOrCreateSigningIdentity(keyPath, 'node-a');
	await assert.rejects(() => loadOrCreateSigningIdentity(keyPath, 'node-b'));
});
