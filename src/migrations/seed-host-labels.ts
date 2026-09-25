import type { Db } from 'mongodb';

const MIGRATION_ID = 'seed-host-labels';

export interface SeedHostLabelsResult {
	seeded: number;
	skipped: number;
	alreadyRan: boolean;
}

/**
 * D10 namespace bootstrap. Runs once, before `MasterRepositories.ensureIndexes`
 * (see `connectMasterRepositories`), so the old plain-unique `subdomain_1`
 * index is never rebuilt after this migration replaces it.
 *
 * OPERATOR: back up master Mongo before the first deploy that ships this
 * migration. It only ever INSERTS into `host_labels` ($setOnInsert, guarded
 * by a completion marker) and never deletes an `apps` row, but the index
 * swap below is a real schema change and the last point a missed label is
 * still recoverable from the raw `apps` collection.
 *
 * Backfills `host_labels` (`_id` = label) from every `apps.subdomain` value —
 * every kind, every state, REMOVED included — so a legacy label can never be
 * claimed twice under a different (workspaceId, listingId): the exact
 * VANITY-takeover risk this migration exists to close (phase-3 risk
 * assessment). Then repoints `apps.subdomain_1` at a PARTIAL unique filter
 * (`{ subdomain: { $type: 'string' } }`), which is what lets a v3 app with no
 * label (MCP_V3_NO_DEFAULT_HOST) coexist with a second host-less app in the
 * same workspace — the old plain-unique index treated every missing
 * `subdomain` as the same `null` key and refused the second one.
 */
export async function seedHostLabels(db: Db): Promise<SeedHostLabelsResult> {
	const migrations = db.collection<{ _id: string; completedAt: Date; seeded: number; skipped: number }>('apps_master_migrations');
	const already = await migrations.findOne({ _id: MIGRATION_ID });
	if (already) return { seeded: 0, skipped: 0, alreadyRan: true };

	const apps = db.collection('apps_master_apps');
	const hostLabels = db.collection<{
		_id: string;
		state: 'HELD' | 'RECLAIMED';
		workspaceId?: string;
		listingId?: string;
		createdAt: Date;
		updatedAt: Date;
	}>('host_labels');

	let seeded = 0;
	let skipped = 0;
	const cursor = apps.find(
		{ subdomain: { $type: 'string' } },
		{ projection: { subdomain: 1, workspaceId: 1, listingId: 1, updatedAt: 1 } },
	);
	for await (const row of cursor) {
		const label = row.subdomain as string;
		const now = new Date();
		const result = await hostLabels.updateOne(
			{ _id: label },
			{
				$setOnInsert: {
					_id: label,
					state: 'HELD',
					workspaceId: row.workspaceId,
					listingId: row.listingId,
					createdAt: row.updatedAt ?? now,
					updatedAt: row.updatedAt ?? now,
				},
			},
			{ upsert: true },
		);
		if (result.upsertedCount) seeded += 1;
		else skipped += 1;
	}

	// dropIndex on an index that never existed (fresh DB, or an already-migrated
	// one re-running after a crash) throws — swallowed, both are fine outcomes.
	// L9: the drop→create window itself is NOT safe against two HA control
	// nodes racing this migration at the same instant (a genuinely concurrent
	// boot could observe the index briefly missing, or duplicate drop/create
	// calls) — accepted under the same single-writer-in-practice boot
	// assumption `host-table-publisher.ts` documents for its own steady-state
	// writes; the completion-marker catch below is what keeps a genuine race
	// from crashing the losing booter, not index-level atomicity.
	await apps.dropIndex('subdomain_1').catch(() => undefined);
	await apps.createIndex(
		{ subdomain: 1 },
		{ unique: true, name: 'subdomain_1', partialFilterExpression: { subdomain: { $type: 'string' } } },
	);

	try {
		await migrations.insertOne({ _id: MIGRATION_ID, completedAt: new Date(), seeded, skipped });
	} catch (error: unknown) {
		// L9: two HA control nodes booting at once can both pass the `already`
		// check above and both redo this (idempotent) work; only one of them
		// wins the marker insert. The loser must self-heal, not crash its boot
		// over a marker its sibling already wrote.
		if ((error as { code?: number }).code !== 11000) throw error;
	}
	return { seeded, skipped, alreadyRan: false };
}
