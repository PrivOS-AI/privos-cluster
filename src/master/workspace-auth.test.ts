import assert from 'node:assert/strict';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import { KeyCipher, hashKey } from './key-crypto.js';
import { WorkspaceAuth } from './workspace-auth.js';

test('workspace path is bound to exactly that workspace key', async () => {
	const cipher = new KeyCipher(Buffer.alloc(32, 5));
	const keys = new Map([['ws-a', 'key-a-0123456789-0123456789'], ['ws-b', 'key-b-0123456789-0123456789']]);
	const repositories = {
		workspaces: {
			findOne: async ({ workspaceId }: { workspaceId: string }) => {
				const key = keys.get(workspaceId);
				return key ? {
					workspaceId,
					status: 'ACTIVE',
					keyHash: hashKey(key),
					encryptedKey: cipher.encrypt(key),
				} : null;
			},
		},
	} as any;
	const auth = new WorkspaceAuth(repositories, cipher);
	const tokenA = jwt.sign(
		{ sub: 'hub-a' },
		keys.get('ws-a')!,
		{ algorithm: 'HS256', issuer: 'privos-chat', expiresIn: '5m' },
	);
	assert.equal((await auth.verify('ws-a', tokenA)).workspaceId, 'ws-a');
	await assert.rejects(() => auth.verify('ws-b', tokenA), /signature/i);
	await assert.rejects(() => auth.verify('unknown', tokenA), /workspace not found/i);
});
