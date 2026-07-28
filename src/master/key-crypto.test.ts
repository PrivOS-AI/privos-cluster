import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyCipher, hashKey } from './key-crypto.js';

test('master key custody encrypts workspace and node keys with integrity', () => {
	const cipher = new KeyCipher(Buffer.alloc(32, 7));
	const encrypted = cipher.encrypt('workspace-secret');
	assert.notEqual(encrypted, 'workspace-secret');
	assert.equal(cipher.decrypt(encrypted), 'workspace-secret');
	assert.equal(hashKey('workspace-secret').length, 64);
	assert.throws(() => new KeyCipher(Buffer.alloc(16)), /32-byte/);
});
