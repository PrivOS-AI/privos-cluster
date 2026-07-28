import type { MasterRepositories } from './repositories.js';
import { KeyCipher, hashKey } from './key-crypto.js';
import type { AvailabilityTier, WorkspaceQuota } from './types.js';

export class WorkspaceClusterService {
	constructor(
		private readonly repositories: MasterRepositories,
		private readonly cipher: KeyCipher,
	) {}

	async upsert(input: {
		workspaceId: string;
		key: string;
		quota: WorkspaceQuota;
		defaultAvailabilityTier?: AvailabilityTier;
	}): Promise<void> {
		const now = new Date();
		await this.repositories.workspaces.updateOne(
			{ workspaceId: input.workspaceId },
			{
				$set: {
					keyHash: hashKey(input.key),
					encryptedKey: this.cipher.encrypt(input.key),
					quota: input.quota,
					defaultAvailabilityTier: input.defaultAvailabilityTier ?? 'single',
					status: 'ACTIVE',
					updatedAt: now,
				},
				$setOnInsert: { createdAt: now },
			},
			{ upsert: true },
		);
	}

	async rotateKey(workspaceId: string, key: string): Promise<void> {
		const result = await this.repositories.workspaces.updateOne(
			{ workspaceId, status: 'ACTIVE' },
			{
				$set: {
					keyHash: hashKey(key),
					encryptedKey: this.cipher.encrypt(key),
					updatedAt: new Date(),
				},
			},
		);
		if (result.matchedCount !== 1) throw new Error('workspace not found');
	}

	async updateQuota(workspaceId: string, quota: WorkspaceQuota): Promise<void> {
		const result = await this.repositories.workspaces.updateOne(
			{ workspaceId, status: 'ACTIVE' },
			{ $set: { quota, updatedAt: new Date() } },
		);
		if (result.matchedCount !== 1) throw new Error('workspace not found');
	}

	async revoke(workspaceId: string): Promise<void> {
		await this.repositories.workspaces.updateOne(
			{ workspaceId },
			{ $set: { status: 'REVOKED', encryptedKey: '', updatedAt: new Date() } },
		);
	}
}
