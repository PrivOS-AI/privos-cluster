import type { MasterRepositories } from './repositories.js';
import { KeyCipher } from './key-crypto.js';
import type { MasterNode, NodeCapacity, NodeStatus } from './types.js';

export class NodeRegistry {
	constructor(
		private readonly repositories: MasterRepositories,
		private readonly cipher: KeyCipher,
	) {}

	async upsert(input: {
		nodeId: string;
		portalNodeId?: string;
		url: string;
		region: string;
		failureDomain: string;
		capacity: NodeCapacity;
		fleetKey: string;
		keyId?: string;
		tunnelId?: string;
		status?: NodeStatus;
	}): Promise<void> {
		const now = new Date();
		await this.repositories.nodes.updateOne(
			{ nodeId: input.nodeId },
			{
				$set: {
					portalNodeId: input.portalNodeId,
					url: input.url,
					region: input.region,
					failureDomain: input.failureDomain,
					capacity: input.capacity,
					encryptedFleetKey: this.cipher.encrypt(input.fleetKey),
					keyId: input.keyId ?? input.nodeId,
					tunnelId: input.tunnelId,
					status: input.status ?? 'ACTIVE',
					updatedAt: now,
				},
				$setOnInsert: { createdAt: now },
			},
			{ upsert: true },
		);
	}

	async setStatus(nodeId: string, status: NodeStatus): Promise<void> {
		const result = await this.repositories.nodes.updateOne(
			{ nodeId },
			{ $set: { status, updatedAt: new Date() } },
		);
		if (result.matchedCount !== 1) throw new Error('node not found');
	}

	async listActive(): Promise<MasterNode[]> {
		return this.repositories.nodes.find({ status: 'ACTIVE' }).toArray();
	}
}
