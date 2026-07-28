import jwt from 'jsonwebtoken';
import type { MasterRepositories } from './repositories.js';
import { KeyCipher, hashKey } from './key-crypto.js';

export class WorkspaceAuth {
	constructor(
		private readonly repositories: MasterRepositories,
		private readonly cipher: KeyCipher,
	) {}

	async verify(workspaceId: string, bearerToken: string): Promise<{ workspaceId: string; sub?: string }> {
		const workspace = await this.repositories.workspaces.findOne({
			workspaceId,
			status: 'ACTIVE',
		});
		if (!workspace) {
			const error: Error & { statusCode?: number } = new Error('workspace not found');
			error.statusCode = 404;
			throw error;
		}
		const key = this.cipher.decrypt(workspace.encryptedKey);
		if (hashKey(key) !== workspace.keyHash) throw new Error('workspace key integrity check failed');
		const payload = jwt.verify(bearerToken, key, {
			algorithms: ['HS256'],
			issuer: 'privos-chat',
		}) as { sub?: string };
		return { workspaceId, sub: payload.sub };
	}
}

export function bearerFromHeader(value: string | undefined): string {
	if (!value?.startsWith('Bearer ')) {
		const error: Error & { statusCode?: number } = new Error('missing bearer token');
		error.statusCode = 401;
		throw error;
	}
	return value.slice('Bearer '.length);
}
