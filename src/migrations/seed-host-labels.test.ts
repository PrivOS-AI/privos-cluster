import assert from 'node:assert/strict';
import test from 'node:test';

import { seedHostLabels } from './seed-host-labels.js';

function fixture(appRows: Array<Record<string, unknown>>) {
	const hostLabelRows: Array<Record<string, unknown>> = [];
	const migrationRows: Array<Record<string, unknown>> = [];
	const dropIndexCalls: string[] = [];
	const createIndexCalls: Array<{ keys: unknown; options: unknown }> = [];

	const collections: Record<string, unknown> = {
		apps_master_apps: {
			find: (filter: Record<string, unknown>) => ({
				async *[Symbol.asyncIterator]() {
					for (const row of appRows) {
						if (filter.subdomain && typeof (filter.subdomain as { $type?: string }).$type === 'string') {
							if (typeof row.subdomain !== 'string') continue;
						}
						yield row;
					}
				},
			}),
			dropIndex: async (name: string) => { dropIndexCalls.push(name); },
			createIndex: async (keys: unknown, options: unknown) => { createIndexCalls.push({ keys, options }); },
		},
		host_labels: {
			updateOne: async (filter: { _id: string }, update: { $setOnInsert: Record<string, unknown> }, options: { upsert: boolean }) => {
				const exists = hostLabelRows.find((row) => row._id === filter._id);
				if (exists) return { upsertedCount: 0 };
				if (options.upsert) hostLabelRows.push({ ...update.$setOnInsert });
				return { upsertedCount: 1 };
			},
		},
		apps_master_migrations: {
			findOne: async (filter: { _id: string }) => migrationRows.find((row) => row._id === filter._id) ?? null,
			insertOne: async (row: Record<string, unknown>) => {
				if (migrationRows.some((candidate) => candidate._id === row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
				migrationRows.push(row);
			},
		},
	};
	const db = { collection: (name: string) => collections[name] } as any;
	return { db, hostLabelRows, migrationRows, dropIndexCalls, createIndexCalls };
}

test('seeds host_labels from every apps.subdomain (REMOVED included), keyed to (workspaceId, listingId)', async () => {
	const { db, hostLabelRows } = fixture([
		{ subdomain: 'acme', workspaceId: 'ws-1', listingId: 'listing-1', updatedAt: new Date('2026-01-01') },
		{ subdomain: 'zeta', workspaceId: 'ws-2', listingId: 'listing-2', state: 'REMOVED', updatedAt: new Date('2026-01-02') },
	]);
	const result = await seedHostLabels(db);
	assert.equal(result.seeded, 2);
	assert.equal(result.alreadyRan, false);
	assert.deepEqual(hostLabelRows.map((row) => row._id).sort(), ['acme', 'zeta']);
	const acme = hostLabelRows.find((row) => row._id === 'acme')!;
	assert.equal(acme.state, 'HELD');
	assert.equal(acme.workspaceId, 'ws-1');
	assert.equal(acme.listingId, 'listing-1');
});

test('repoints subdomain_1 to a partial unique index and records a completion marker', async () => {
	const { db, dropIndexCalls, createIndexCalls, migrationRows } = fixture([]);
	await seedHostLabels(db);
	assert.deepEqual(dropIndexCalls, ['subdomain_1']);
	assert.equal(createIndexCalls.length, 1);
	assert.deepEqual(createIndexCalls[0]!.keys, { subdomain: 1 });
	assert.deepEqual(createIndexCalls[0]!.options, {
		unique: true,
		name: 'subdomain_1',
		partialFilterExpression: { subdomain: { $type: 'string' } },
	});
	assert.equal(migrationRows.length, 1);
	assert.equal(migrationRows[0]!._id, 'seed-host-labels');
});

test('is idempotent: a second run is a no-op once the completion marker exists', async () => {
	const { db } = fixture([{ subdomain: 'acme', workspaceId: 'ws-1', listingId: 'listing-1' }]);
	await seedHostLabels(db);
	const second = await seedHostLabels(db);
	assert.equal(second.alreadyRan, true);
	assert.equal(second.seeded, 0);
});

test('L9: two HA control nodes racing this migration at first boot — the loser self-heals instead of crashing on the marker E11000', async () => {
	// Simulates the SECOND booter: its own `already` check (findOne) ran
	// before the FIRST booter's marker write landed — so it proceeds through
	// the whole (idempotent) seed+index pass — and only its own marker
	// `insertOne` discovers the other booter already won.
	const collections: Record<string, unknown> = {
		apps_master_apps: {
			find: () => ({ async *[Symbol.asyncIterator]() { /* no rows */ } }),
			dropIndex: async () => undefined,
			createIndex: async () => undefined,
		},
		host_labels: { updateOne: async () => ({ upsertedCount: 0 }) },
		apps_master_migrations: {
			findOne: async () => null,
			insertOne: async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); },
		},
	};
	const db = { collection: (name: string) => collections[name] } as any;
	await assert.doesNotReject(seedHostLabels(db));
});
