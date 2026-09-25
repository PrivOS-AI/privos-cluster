/**
 * C: `NodeRegistry.upsert` gains `role`/`meshIp`, back-compat (absent role =
 * RUNTIME everywhere else already assumes this — see `HostTablePublisher`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { NodeRegistry } from './node-registry.js';
import { KeyCipher } from './key-crypto.js';

function fixture() {
	const rows: Array<Record<string, unknown>> = [];
	const nodes = {
		updateOne: async (filter: { nodeId: string }, update: { $set: Record<string, unknown>; $setOnInsert: Record<string, unknown> }, options: { upsert: boolean }) => {
			const existing = rows.find((row) => row.nodeId === filter.nodeId);
			if (existing) {
				Object.assign(existing, update.$set);
				return { matchedCount: 1 };
			}
			if (options.upsert) rows.push({ ...update.$setOnInsert, ...update.$set });
			return { matchedCount: 0 };
		},
	};
	const registry = new NodeRegistry({ nodes } as any, new KeyCipher(Buffer.alloc(32, 3)));
	return { registry, rows };
}

test('upsert stores role and meshIp when given', async () => {
	const { registry, rows } = fixture();
	await registry.upsert({
		nodeId: 'node-1', url: 'https://node-1.internal', region: 'eu', failureDomain: 'fd-1',
		capacity: { memoryMb: 4096, cpus: 4, diskBytes: 1 }, fleetKey: 'k'.repeat(32),
		role: 'INGRESS', meshIp: '10.88.0.11',
	});
	assert.equal(rows[0]!.role, 'INGRESS');
	assert.equal(rows[0]!.meshIp, '10.88.0.11');
});

test('upsert omits role/meshIp when absent — a node registered before public-hostnames rolled is unaffected', async () => {
	const { registry, rows } = fixture();
	await registry.upsert({
		nodeId: 'node-1', url: 'https://node-1.internal', region: 'eu', failureDomain: 'fd-1',
		capacity: { memoryMb: 4096, cpus: 4, diskBytes: 1 }, fleetKey: 'k'.repeat(32),
	});
	assert.equal('role' in rows[0]!, false);
	assert.equal('meshIp' in rows[0]!, false);
});
