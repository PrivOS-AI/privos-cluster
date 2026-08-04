import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson, jwkThumbprint, parseJws, sha256, sha256Base64Url, signEs256Jws, verifyEs256Jws } from './artifacts.js';
import { generateNodeIdentity, rotateNodeIdentityFile, validateNodeIdentity } from './node-identity.js';

test('canonical JSON and digest are stable across property order', () => {
	assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
	assert.equal(sha256(canonicalJson({ b: 2, a: 1 })), sha256(canonicalJson({ a: 1, b: 2 })));
	assert.match(sha256Base64Url(canonicalJson({ a: 1 })), /^[A-Za-z0-9_-]{43}$/);
});

test('canonical JSON freezes locale-independent UTF-16 code-unit ordering', () => {
	const canonical = canonicalJson({ 'ä': 1, Z: 2, a: 3, A: 4 });
	assert.equal(canonical, '{"A":4,"Z":2,"a":3,"ä":1}');
	assert.equal(sha256Base64Url(canonical), '6sXZfEHGkkeyqCwwo0Dfx0-UboWlGXnMKRCmhTAblK8');
});

test('ES256 artifacts verify only with the pinned key and type', () => {
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const privateJwk = pair.privateKey.export({ format: 'jwk' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' });
	const kid = jwkThumbprint(publicJwk);
	const compact = signEs256Jws({ payload: { value: 'ok' }, privateJwk, kid, typ: 'test+jws' });
	assert.equal(parseJws(compact).header.privos_protocol, 2);
	assert.equal(verifyEs256Jws({ compact, publicJwk, kid, typ: 'test+jws' }).payload.value, 'ok');
	assert.throws(() => verifyEs256Jws({ compact, publicJwk, kid, typ: 'wrong+jws' }), /artifact_signature_invalid/);
});

test('node identity validation binds the persisted public key to its private key', () => {
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const replacement = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const privateJwk = pair.privateKey.export({ format: 'jwk' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' });
	const replacementPublicJwk = replacement.publicKey.export({ format: 'jwk' });
	const identity = {
		version: 1 as const,
		nodeId: 'node-1',
		privateJwk,
		publicJwk,
		kid: jwkThumbprint(publicJwk),
		createdAt: new Date().toISOString(),
	};
	assert.equal(validateNodeIdentity(identity, 'node-1'), identity);
	assert.throws(
		() => validateNodeIdentity({ ...identity, publicJwk: replacementPublicJwk, kid: jwkThumbprint(replacementPublicJwk) }, 'node-1'),
		/node_identity_invalid/,
	);
});

test('node identity rotation is atomic and preserves a private recovery copy', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'privos-node-identity-'));
	const filePath = path.join(directory, 'identity.json');
	try {
		const original = generateNodeIdentity('node-1');
		await fs.writeFile(filePath, `${JSON.stringify(original)}\n`, { mode: 0o600 });
		const rotated = await rotateNodeIdentityFile(filePath, 'node-1');
		const current = validateNodeIdentity(JSON.parse(await fs.readFile(filePath, 'utf8')), 'node-1');
		const backup = validateNodeIdentity(JSON.parse(await fs.readFile(rotated.backupPath, 'utf8')), 'node-1');
		assert.equal(rotated.previousKid, original.kid);
		assert.equal(backup.kid, original.kid);
		assert.equal(rotated.kid, current.kid);
		assert.notEqual(current.kid, original.kid);
		assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
		assert.equal((await fs.stat(rotated.backupPath)).mode & 0o777, 0o600);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
