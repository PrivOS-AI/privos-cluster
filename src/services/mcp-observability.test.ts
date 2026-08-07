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

test('a code that reduces to a single character falls back rather than passing through', () => {
	// Callers upper-case this into a signed acknowledgement `errorCode` and feed
	// it to `SafeReasonCode` (min length 2, `^[A-Z][A-Z0-9_]{1,95}$`). A 1-char
	// result here would fail that parse later, unhandled, inside the very error
	// path that is supposed to still return a signed FAILED/ROLLED_BACK ack.
	assert.equal(clusterMcpSafeReason(new Error('e')), 'internal_error');
	assert.equal(clusterMcpSafeReason(new Error('!'), 'upgrade_failed'), 'upgrade_failed');
	assert.equal(clusterMcpSafeReason(new Error('ok')), 'ok');
});
