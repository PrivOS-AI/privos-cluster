import assert from 'node:assert/strict';
import test from 'node:test';

import { reapExpiredQuarantines, resolveQuarantineGraceMs, DEFAULT_QUARANTINE_GRACE_MS } from './quarantine-reaper.js';

test('resolveQuarantineGraceMs: env override, default, and fail-safe on garbage', () => {
	assert.equal(resolveQuarantineGraceMs({}), DEFAULT_QUARANTINE_GRACE_MS);
	assert.equal(resolveQuarantineGraceMs({ APP_CLUSTER_QUARANTINE_GRACE_MS: '3600000' }), 3_600_000);
	// A non-positive or malformed value must never shorten the window to ~0.
	assert.equal(resolveQuarantineGraceMs({ APP_CLUSTER_QUARANTINE_GRACE_MS: '0' }), DEFAULT_QUARANTINE_GRACE_MS);
	assert.equal(resolveQuarantineGraceMs({ APP_CLUSTER_QUARANTINE_GRACE_MS: 'nope' }), DEFAULT_QUARANTINE_GRACE_MS);
});

test('reapExpiredQuarantines reaps only apps past the grace window, and is batch-fault-tolerant', async () => {
	const now = new Date('2026-08-25T00:00:00Z');
	const grace = 7 * 24 * 60 * 60 * 1000;
	// old-1 + old-2 are past grace; young is within grace and must be left alone.
	const expired = [
		{ workspaceId: 'ws-a', appId: 'old-1', quarantinedAt: new Date('2026-08-10T00:00:00Z') },
		{ workspaceId: 'ws-b', appId: 'old-2', quarantinedAt: new Date('2026-08-01T00:00:00Z') },
	];
	let queried: unknown;
	const reaped: string[] = [];
	const repositories = {
		apps: {
			find: (filter: unknown) => {
				queried = filter;
				return { toArray: async () => expired };
			},
		},
	} as never;
	const lifecycle = {
		reapQuarantined: async (_ws: string, appId: string) => {
			if (appId === 'old-2') throw new Error('agent unreachable');
			reaped.push(appId);
		},
	} as never;

	const result = await reapExpiredQuarantines(repositories, lifecycle, { graceMs: grace, now });

	assert.deepEqual(queried, { state: 'QUARANTINED', quarantinedAt: { $lte: new Date(now.getTime() - grace) } });
	assert.deepEqual(reaped, ['old-1']); // old-1 succeeded
	assert.deepEqual(result, { scanned: 2, reaped: 1, failed: 1 }); // old-2 failed but did not abort the batch
});
