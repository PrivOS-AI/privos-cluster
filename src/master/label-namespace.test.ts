/**
 * D10: one label namespace, HELD | RECLAIMED, tombstones kept forever.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { LabelNamespace, type HostLabelRecord } from './label-namespace.js';

function fixture() {
	const rows: HostLabelRecord[] = [];
	const hostLabels = {
		findOne: async (filter: { _id: string }) => rows.find((row) => row._id === filter._id) ?? null,
		insertOne: async (row: HostLabelRecord) => {
			if (rows.some((candidate) => candidate._id === row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
			rows.push({ ...row });
			return { acknowledged: true };
		},
		updateOne: async (filter: { _id: string; state?: string }, update: { $set?: Partial<HostLabelRecord>; $unset?: Record<string, unknown> }) => {
			const row = rows.find((candidate) => candidate._id === filter._id && (!filter.state || candidate.state === filter.state));
			if (!row) return { matchedCount: 0 };
			if (update.$set) Object.assign(row, update.$set);
			if (update.$unset) for (const key of Object.keys(update.$unset)) delete (row as unknown as Record<string, unknown>)[key];
			return { matchedCount: 1 };
		},
	};
	const namespace = new LabelNamespace({ hostLabels } as any);
	return { namespace, rows };
}

test('a fresh label is available, and hold() claims it HELD for its owner', async () => {
	const { namespace, rows } = fixture();
	assert.equal(await namespace.isAvailable('acme'), true);
	await namespace.hold('acme', { workspaceId: 'ws-1', listingId: 'listing-1' });
	assert.equal(await namespace.isAvailable('acme'), false);
	assert.equal(rows[0]!.state, 'HELD');
	assert.equal(rows[0]!.workspaceId, 'ws-1');
});

test('a second hold on the same label is refused as LABEL_ALREADY_CLAIMED, whatever the caller', async () => {
	const { namespace } = fixture();
	await namespace.hold('acme', { workspaceId: 'ws-1', listingId: 'listing-1' });
	await assert.rejects(
		namespace.hold('acme', { workspaceId: 'ws-2', listingId: 'listing-2' }),
		(error: any) => error.code === 'LABEL_ALREADY_CLAIMED',
	);
});

test('release tombstones a label as RECLAIMED rather than deleting it — it stays unavailable', async () => {
	const { namespace, rows } = fixture();
	await namespace.hold('acme', { workspaceId: 'ws-1', listingId: 'listing-1' });
	await namespace.release('acme');
	assert.equal(rows[0]!.state, 'RECLAIMED');
	assert.equal(rows[0]!.workspaceId, undefined);
	assert.equal(await namespace.isAvailable('acme'), false);
	await assert.rejects(namespace.hold('acme', { workspaceId: 'ws-2', listingId: 'listing-2' }));
});

test('reassign moves a RECLAIMED label back to HELD under a new owner; refuses a label that is not RECLAIMED', async () => {
	const { namespace, rows } = fixture();
	await namespace.hold('acme', { workspaceId: 'ws-1', listingId: 'listing-1' });
	await assert.rejects(namespace.reassign('acme', { workspaceId: 'ws-2', listingId: 'listing-2' }));
	await namespace.release('acme');
	await namespace.reassign('acme', { workspaceId: 'ws-2', listingId: 'listing-2' });
	assert.equal(rows[0]!.state, 'HELD');
	assert.equal(rows[0]!.workspaceId, 'ws-2');
});

test('allocate retries past a claimed candidate and returns the first free one', async () => {
	const { namespace } = fixture();
	await namespace.hold('acme-1', { workspaceId: 'ws-1', listingId: 'listing-1' });
	let attempts = 0;
	const label = await namespace.allocate(
		(attempt) => { attempts = attempt; return attempt === 0 ? 'acme-1' : 'acme-2'; },
		{ workspaceId: 'ws-2', listingId: 'listing-2' },
	);
	assert.equal(label, 'acme-2');
	assert.equal(attempts, 1);
});

test('isAvailableFor reports a HELD label the caller already owns as available, but a stranger\'s label as taken', async () => {
	const { namespace } = fixture();
	await namespace.hold('acme', { workspaceId: 'ws-1', listingId: 'listing-1' });
	assert.equal(await namespace.isAvailableFor('acme', 'ws-1'), true);
	assert.equal(await namespace.isAvailableFor('acme', 'ws-2'), false);
	assert.equal(await namespace.isAvailableFor('never-claimed', 'ws-2'), true);
});
