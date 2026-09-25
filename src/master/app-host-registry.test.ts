/**
 * D + E: the public-hostname registry — reserve (pre-registration), the
 * full-desired-set PUT, teardown scoped by generation, and D19 workspace
 * suspend/resume.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AppHostRegistry, type AppHostRecord } from './app-host-registry.js';
import { LabelNamespace } from './label-namespace.js';
import { WorkspaceLock } from './workspace-lock.js';

function matchesRow(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
	return Object.entries(filter).every(([key, condition]) => {
		const value = row[key];
		if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
			const operator = condition as { $ne?: unknown; $in?: unknown[]; $type?: string; $lte?: Date; $exists?: boolean };
			if ('$ne' in operator) return value !== operator.$ne;
			if ('$in' in operator) return operator.$in!.includes(value);
			if ('$type' in operator) return operator.$type === 'string' ? typeof value === 'string' : true;
			if ('$lte' in operator) return value instanceof Date && operator.$lte instanceof Date && value.getTime() <= operator.$lte.getTime();
			if ('$exists' in operator) return operator.$exists ? value !== undefined : value === undefined;
		}
		return value === condition;
	});
}

function fixture() {
	const hostRows: AppHostRecord[] = [];
	const labelRows: Array<{ _id: string; state: string; workspaceId?: string; listingId?: string }> = [];
	let publisherDirtyCalls = 0;
	let cfNotifyCalls = 0;

	const appHosts = {
		findOne: async (filter: { _id: string }) => hostRows.find((row) => row._id === filter._id) ?? null,
		find: (filter: Record<string, unknown>) => ({
			toArray: async () => hostRows.filter((row) => matchesRow(row as unknown as Record<string, unknown>, filter)),
		}),
		insertOne: async (row: AppHostRecord) => {
			if (hostRows.some((candidate) => candidate._id === row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
			hostRows.push({ ...row });
			return { acknowledged: true };
		},
		updateOne: async (filter: { _id: string }, update: { $set?: Partial<AppHostRecord> }) => {
			const row = hostRows.find((candidate) => candidate._id === filter._id);
			if (!row) return { matchedCount: 0 };
			if (update.$set) Object.assign(row, update.$set);
			return { matchedCount: 1 };
		},
		updateMany: async (filter: Record<string, unknown>, update: { $set?: Partial<AppHostRecord>; $unset?: Record<string, unknown> }) => {
			const matched = hostRows.filter((row) => matchesRow(row as unknown as Record<string, unknown>, filter));
			for (const row of matched) {
				if (update.$set) Object.assign(row, update.$set);
				if (update.$unset) for (const key of Object.keys(update.$unset)) delete (row as unknown as Record<string, unknown>)[key];
			}
			return { modifiedCount: matched.length };
		},
	};
	const hostLabels = {
		findOne: async (filter: { _id: string }) => labelRows.find((row) => row._id === filter._id) ?? null,
		insertOne: async (row: { _id: string; state: string; workspaceId?: string; listingId?: string }) => {
			if (labelRows.some((candidate) => candidate._id === row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
			labelRows.push({ ...row });
		},
		updateOne: async () => ({ matchedCount: 0 }),
	};
	const namespace = new LabelNamespace({ hostLabels } as any);
	const publisher = { markDirty: () => { publisherDirtyCalls += 1; } };
	const cfWorker = { notify: () => { cfNotifyCalls += 1; } };
	const registry = new AppHostRegistry({
		repositories: { appHosts } as any,
		namespace,
		locks: new WorkspaceLock(),
		cfWorker: cfWorker as any,
		publisher: publisher as any,
	});
	return { registry, hostRows, labelRows, get publisherDirtyCalls() { return publisherDirtyCalls; }, get cfNotifyCalls() { return cfNotifyCalls; } };
}

test('reserve pre-registers a row and holds its label; a second reserve of the SAME app is idempotent', async () => {
	const { registry, hostRows, labelRows } = fixture();
	const row = await registry.reserve({ workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1', hostname: 'acme.privos.link', kind: 'VANITY' });
	assert.equal(row.state, 'PENDING');
	assert.equal(hostRows.length, 1);
	assert.equal(labelRows[0]!.state, 'HELD');
	const again = await registry.reserve({ workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1', hostname: 'acme.privos.link', kind: 'VANITY' });
	assert.deepEqual(again, row);
});

test('reserve refuses a hostname another app already owns, and a CUSTOM hostname never touches the label namespace', async () => {
	const { registry, labelRows } = fixture();
	await registry.reserve({ workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1', hostname: 'acme.privos.link', kind: 'VANITY' });
	await assert.rejects(
		registry.reserve({ workspaceId: 'ws-2', appId: 'app-2', listingId: 'listing-2', hostname: 'acme.privos.link', kind: 'VANITY' }),
		(error: any) => error.statusCode === 409,
	);
	await registry.reserve({ workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1', hostname: 'app.customer.com', kind: 'CUSTOM' });
	assert.equal(labelRows.some((row) => row._id === 'app.customer.com'), false, 'a CUSTOM hostname is on the operator\'s own domain, not the shared namespace');
});

test('L6: a CUSTOM cross-workspace race that loses at insertOne (raw E11000) is mapped to a clean HOST_CONFLICT 409, never a bare {error: 11000}', async () => {
	// A CUSTOM hostname holds no label (see the test above), so the unique
	// `_id` index on `app_hosts` itself is the only thing that can catch two
	// workspaces racing to reserve the SAME hostname concurrently — both pass
	// this request's own `findOne` (stale relative to the other, in-flight
	// write) and only the loser's `insertOne` fails.
	const namespace = new LabelNamespace({ hostLabels: { findOne: async () => null, insertOne: async () => undefined } } as any);
	const registry = new AppHostRegistry({
		repositories: {
			appHosts: {
				findOne: async () => null,
				insertOne: async () => { throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }); },
			},
		} as any,
		namespace,
		locks: new WorkspaceLock(),
	});
	await assert.rejects(
		registry.reserve({ workspaceId: 'ws-2', appId: 'app-2', listingId: 'listing-2', hostname: 'app.customer.com', kind: 'CUSTOM' }),
		(error: any) => {
			assert.equal(error.code, 'HOST_CONFLICT');
			assert.equal(error.statusCode, 409);
			assert.equal(error.hostname, 'app.customer.com');
			return true;
		},
	);
});

test('L7: reserve self-heals when its own prior hold succeeded but the app_hosts insert never landed', async () => {
	const { registry, hostRows, labelRows } = fixture();
	// Simulates a `reserve()` that held the label, then crashed/lost its
	// write before the `insertOne` below — the label is HELD by the rightful
	// (workspaceId, listingId), but no `app_hosts` row exists for it yet.
	const now = new Date();
	labelRows.push({ _id: 'acme', state: 'HELD', workspaceId: 'ws-1', listingId: 'listing-1' });
	assert.equal(hostRows.length, 0);

	const row = await registry.reserve({ workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1', hostname: 'acme.privos.link', kind: 'VANITY' });
	assert.equal(row.state, 'PENDING');
	assert.equal(hostRows.length, 1);
	assert.equal(hostRows[0]!._id, 'acme.privos.link');
});

test('L7: reserve still refuses a label truly held by a different workspace, self-heal does not weaken the conflict check', async () => {
	const { registry, labelRows } = fixture();
	labelRows.push({ _id: 'acme', state: 'HELD', workspaceId: 'ws-STRANGER', listingId: 'listing-stranger' });
	await assert.rejects(
		registry.reserve({ workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1', hostname: 'acme.privos.link', kind: 'VANITY' }),
		(error: any) => error.code === 'LABEL_ALREADY_CLAIMED' && error.statusCode === 409,
	);
});

test('setDesiredHosts refuses more than one primary', async () => {
	const { registry } = fixture();
	await assert.rejects(
		registry.setDesiredHosts({
			workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1',
			hosts: [
				{ hostname: 'a.privos.link', kind: 'VANITY', primary: true, state: 'ACTIVE' },
				{ hostname: 'b.privos.link', kind: 'VANITY', primary: true, state: 'ACTIVE' },
			],
		}),
		(error: any) => error.code === 'MULTIPLE_PRIMARY_HOSTS',
	);
});

test('setDesiredHosts writes new rows, updates existing ones, and moves anything no longer desired to DELETING', async () => {
	const state = fixture();
	const { registry, hostRows } = state;
	await registry.setDesiredHosts({
		workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1', generationId: 'gen-1',
		hosts: [
			{ hostname: 'a.privos.link', kind: 'VANITY', primary: true, state: 'ACTIVE' },
			{ hostname: 'b.privos.link', kind: 'VANITY', primary: false, state: 'ACTIVE' },
		],
	});
	assert.equal(hostRows.length, 2);
	assert.equal(state.publisherDirtyCalls, 1);
	assert.equal(state.cfNotifyCalls, 1);

	await registry.setDesiredHosts({
		workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1', generationId: 'gen-1',
		hosts: [{ hostname: 'a.privos.link', kind: 'VANITY', primary: true, state: 'SUSPENDED' }],
	});
	const a = hostRows.find((row) => row._id === 'a.privos.link')!;
	const b = hostRows.find((row) => row._id === 'b.privos.link')!;
	assert.equal(a.state, 'SUSPENDED');
	assert.equal(b.state, 'DELETING', 'dropped from the desired set → DELETING, never silently deleted');
});

test('setDesiredHosts refuses a hostname another app already holds, tagging the conflicting hostname', async () => {
	const { registry } = fixture();
	await registry.setDesiredHosts({
		workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1',
		hosts: [{ hostname: 'shared.privos.link', kind: 'VANITY', primary: true, state: 'ACTIVE' }],
	});
	await assert.rejects(
		registry.setDesiredHosts({
			workspaceId: 'ws-2', appId: 'app-2', listingId: 'listing-2',
			hosts: [{ hostname: 'shared.privos.link', kind: 'VANITY', primary: true, state: 'ACTIVE' }],
		}),
		(error: any) => error.code === 'HOST_CONFLICT' && error.hostname === 'shared.privos.link',
	);
});

test('removeAllAppHosts scoped to a generationId keeps a reinstall\'s new hosts', async () => {
	const { registry, hostRows } = fixture();
	await registry.setDesiredHosts({
		workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1', generationId: 'gen-1',
		hosts: [{ hostname: 'old.privos.link', kind: 'VANITY', primary: true, state: 'ACTIVE' }],
	});
	await registry.setDesiredHosts({
		workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1', generationId: 'gen-2',
		hosts: [
			{ hostname: 'old.privos.link', kind: 'VANITY', primary: false, state: 'ACTIVE' },
			{ hostname: 'new.privos.link', kind: 'VANITY', primary: true, state: 'ACTIVE' },
		],
	});
	// `old.privos.link` is now tagged gen-2 (the desired set overwrote it); a
	// teardown scoped to gen-1 must therefore find NOTHING left to remove.
	const removedGen1 = await registry.removeAllAppHosts('app-1', 'gen-1');
	assert.equal(removedGen1, 0);
	const removedGen2 = await registry.removeAllAppHosts('app-1', 'gen-2');
	assert.equal(removedGen2, 2);
	assert.ok(hostRows.every((row) => row.state === 'DELETING'));
});

test('setWorkspaceHostsSuspended flips ACTIVE hosts to WS_SUSPENDED (keeping the label/CF hostname) and resume clears it', async () => {
	const { registry, hostRows } = fixture();
	await registry.setDesiredHosts({
		workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1',
		hosts: [{ hostname: 'a.privos.link', kind: 'CUSTOM', primary: true, state: 'ACTIVE' }],
	});
	hostRows[0]!.cfHostnameId = 'cf-id-1';
	// A brand-new row starts PENDING (CF/ingress has not confirmed it live
	// yet) — simulate that it has since gone ACTIVE, which is this test's
	// actual precondition.
	hostRows[0]!.state = 'ACTIVE';

	const suspended = await registry.setWorkspaceHostsSuspended('ws-1', true);
	assert.equal(suspended, 1);
	assert.equal(hostRows[0]!.state, 'WS_SUSPENDED');
	assert.ok(hostRows[0]!.wsSuspendedAt instanceof Date);
	assert.equal(hostRows[0]!.cfHostnameId, 'cf-id-1', 'suspend never touches the CF hostname');

	const resumed = await registry.setWorkspaceHostsSuspended('ws-1', false);
	assert.equal(resumed, 1);
	assert.equal(hostRows[0]!.state, 'ACTIVE');
	assert.equal(hostRows[0]!.wsSuspendedAt, undefined);
});

test('M3: a per-host admin SUSPENDED survives a workspace suspend+resume cycle — resume restores SUSPENDED, never ACTIVE', async () => {
	const { registry, hostRows } = fixture();
	await registry.setDesiredHosts({
		workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1',
		hosts: [
			{ hostname: 'admin-suspended.privos.link', kind: 'VANITY', primary: false, state: 'SUSPENDED' },
			{ hostname: 'active.privos.link', kind: 'VANITY', primary: true, state: 'ACTIVE' },
		],
	});
	// New rows start PENDING; simulate that both have since settled into the
	// state their last `setDesiredHosts` call actually asked for — the real
	// precondition this test means to exercise.
	hostRows.find((row) => row._id === 'admin-suspended.privos.link')!.state = 'SUSPENDED';
	hostRows.find((row) => row._id === 'active.privos.link')!.state = 'ACTIVE';

	await registry.setWorkspaceHostsSuspended('ws-1', true);
	const suspendedRow = hostRows.find((row) => row._id === 'admin-suspended.privos.link')!;
	const activeRow = hostRows.find((row) => row._id === 'active.privos.link')!;
	assert.equal(suspendedRow.state, 'WS_SUSPENDED');
	assert.equal(suspendedRow.preSuspendState, 'SUSPENDED');
	assert.equal(activeRow.preSuspendState, 'ACTIVE');

	await registry.setWorkspaceHostsSuspended('ws-1', false);
	assert.equal(suspendedRow.state, 'SUSPENDED', 'the admin suspension must survive the ws suspend/resume cycle');
	assert.equal(suspendedRow.preSuspendState, undefined);
	assert.equal(activeRow.state, 'ACTIVE');
});

test('M3: a row suspended before preSuspendState existed falls back to ACTIVE on resume (back-compat)', async () => {
	const { registry, hostRows } = fixture();
	const now = new Date();
	hostRows.push({
		_id: 'legacy.privos.link', workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1',
		kind: 'VANITY', primary: true, state: 'WS_SUSPENDED', wsSuspendedAt: now, createdAt: now, updatedAt: now,
	});
	await registry.setWorkspaceHostsSuspended('ws-1', false);
	assert.equal(hostRows[0]!.state, 'ACTIVE');
});

test('findSuspendedHostsPastCfRetention only returns CUSTOM hosts past the retention window', async () => {
	const { registry, hostRows } = fixture();
	const now = new Date('2026-01-31T00:00:00Z');
	hostRows.push(
		{ _id: 'old.custom.com', workspaceId: 'ws-1', appId: 'app-1', listingId: 'l-1', kind: 'CUSTOM', primary: true, state: 'WS_SUSPENDED', cfHostnameId: 'cf-1', wsSuspendedAt: new Date('2025-12-01T00:00:00Z'), createdAt: now, updatedAt: now },
		{ _id: 'recent.custom.com', workspaceId: 'ws-1', appId: 'app-2', listingId: 'l-2', kind: 'CUSTOM', primary: true, state: 'WS_SUSPENDED', cfHostnameId: 'cf-2', wsSuspendedAt: new Date('2026-01-25T00:00:00Z'), createdAt: now, updatedAt: now },
		{ _id: 'vanity.privos.link', workspaceId: 'ws-1', appId: 'app-3', listingId: 'l-3', kind: 'VANITY', primary: true, state: 'WS_SUSPENDED', wsSuspendedAt: new Date('2025-12-01T00:00:00Z'), createdAt: now, updatedAt: now },
	);
	const candidates = await registry.findSuspendedHostsPastCfRetention(30, now);
	assert.deepEqual(candidates.map((row) => row._id), ['old.custom.com']);
});
