import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectNodes, SchedulingError } from './scheduler.js';
import type { MasterNode } from './types.js';

function node(nodeId: string, memoryMb: number, failureDomain: string): MasterNode {
	const now = new Date();
	return {
		nodeId,
		url: `http://${nodeId}`,
		region: 'eu',
		failureDomain,
		capacity: { memoryMb, cpus: 8, diskBytes: 1_000_000 },
		status: 'ACTIVE',
		keyId: nodeId,
		encryptedFleetKey: 'encrypted',
		createdAt: now,
		updatedAt: now,
	};
}

test('scheduler ranks by free reserved memory and keeps app placement capacity-aware', () => {
	const selected = selectNodes({
		nodes: [node('small', 1024, 'dc-a'), node('large', 4096, 'dc-b')],
		reservations: [],
		resources: { memoryMb: 512, cpus: 0.5, tmpSizeMb: 64 },
		storageBytes: 0,
		replicas: 1,
	});
	assert.equal(selected[0]?.nodeId, 'large');
});

test('HA requires two distinct failure domains and never silently downgrades', () => {
	assert.throws(
		() => selectNodes({
			nodes: [node('one', 4096, 'dc-a'), node('two', 4096, 'dc-a')],
			reservations: [],
			resources: { memoryMb: 512, cpus: 0.5, tmpSizeMb: 64 },
			storageBytes: 0,
			replicas: 2,
		}),
		(error: unknown) =>
			error instanceof SchedulingError &&
			error.code === 'HA_CAPACITY_UNAVAILABLE',
	);
});
