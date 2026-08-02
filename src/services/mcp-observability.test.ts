import assert from 'node:assert/strict';
import test from 'node:test';

import {
	clusterMcpSafeReason,
	getClusterMcpMetrics,
	recordClusterMcpEvent,
	resetClusterMcpMetricsForTests,
} from './mcp-observability.js';

test('MCP metrics expose bounded aggregate labels only', () => {
	resetClusterMcpMetricsForTests();
	recordClusterMcpEvent({
		event: 'private_dispatch',
		outcome: 'denied',
		boundary: 'agent',
		reason: 'dispatch_assertion_replayed',
		correlationId: 'installation-private-id',
		emitLog: false,
	});
	assert.deepEqual(getClusterMcpMetrics(), [{
		event: 'private_dispatch',
		outcome: 'denied',
		boundary: 'agent',
		reason: 'dispatch_assertion_replayed',
		count: 1,
	}]);
});

test('arbitrary error text cannot become a metric or API reason code', () => {
	assert.equal(clusterMcpSafeReason(new Error('Authorization: Bearer raw-secret')), 'internal_error');
	assert.equal(clusterMcpSafeReason(new Error('dispatch_assertion_replayed')), 'dispatch_assertion_replayed');
});
