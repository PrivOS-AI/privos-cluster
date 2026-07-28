import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveIngressTunnelId } from './ingress-route-programmer.js';
import type { MasterNode } from './types.js';

function node(nodeId: string, tunnelId?: string): MasterNode {
	return {
		nodeId,
		url: `http://${nodeId}:4100`,
		region: 'eu',
		failureDomain: nodeId,
		capacity: { memoryMb: 8192, cpus: 4, diskBytes: 1000 },
		status: 'ACTIVE',
		keyId: nodeId,
		encryptedFleetKey: 'sealed',
		tunnelId,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

test('HA ingress accepts one named tunnel replicated across hosting nodes', () => {
	assert.equal(resolveIngressTunnelId([node('a', 'tunnel-1'), node('b', 'tunnel-1')]), 'tunnel-1');
});

test('HA ingress rejects mismatched per-node tunnels unless an explicit HA tunnel is supplied', () => {
	const nodes = [node('a', 'tunnel-1'), node('b', 'tunnel-2')];
	assert.equal(resolveIngressTunnelId(nodes), undefined);
	assert.equal(resolveIngressTunnelId(nodes, 'ha-tunnel'), 'ha-tunnel');
});
