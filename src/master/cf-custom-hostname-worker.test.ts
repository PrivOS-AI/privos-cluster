/**
 * D: CF custom-hostname worker — runs off the request path, never adopts a
 * foreign Cloudflare object, and the retention sweep releases + marks
 * CF_RELEASED without ever touching a label.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CfCustomHostnameWorker } from './cf-custom-hostname-worker.js';
import type { AppHostRecord } from './app-host-registry.js';

function withFetch(handler: (url: string, init: RequestInit | undefined) => Promise<Response>, run: () => Promise<void>) {
	const original = globalThis.fetch;
	globalThis.fetch = handler as typeof fetch;
	return run().finally(() => { globalThis.fetch = original; });
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fixture() {
	const rows: AppHostRecord[] = [];
	const appHosts = {
		find: (filter: Record<string, unknown>) => ({
			toArray: async () => rows.filter((row) => Object.entries(filter).every(([key, condition]) => {
				const value = (row as unknown as Record<string, unknown>)[key];
				if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
					const operator = condition as { $in?: unknown[]; $type?: string; $lte?: Date; $exists?: boolean };
					if ('$in' in operator) return operator.$in!.includes(value);
					if ('$type' in operator) return operator.$type === 'string' ? typeof value === 'string' : true;
					if ('$lte' in operator) return value instanceof Date && operator.$lte instanceof Date && value.getTime() <= operator.$lte.getTime();
					if ('$exists' in operator) return operator.$exists ? value !== undefined : value === undefined;
				}
				return value === condition;
			})),
		}),
		updateOne: async (filter: { _id: string; state?: string }, update: { $set?: Partial<AppHostRecord>; $unset?: Record<string, unknown> }) => {
			const row = rows.find((candidate) => candidate._id === filter._id && (!filter.state || candidate.state === filter.state));
			if (!row) return { matchedCount: 0 };
			if (update.$set) Object.assign(row, update.$set);
			if (update.$unset) for (const key of Object.keys(update.$unset)) delete (row as unknown as Record<string, unknown>)[key];
			return { matchedCount: 1 };
		},
		deleteOne: async (filter: { _id: string }) => {
			const index = rows.findIndex((row) => row._id === filter._id);
			if (index === -1) return { deletedCount: 0 };
			rows.splice(index, 1);
			return { deletedCount: 1 };
		},
	};
	const worker = new CfCustomHostnameWorker({
		repositories: { appHosts } as any,
		enabled: true,
		zoneId: 'zone-1',
		apiToken: 'token-1',
		sleep: async () => undefined,
	});
	return { worker, rows };
}

function host(overrides: Partial<AppHostRecord>): AppHostRecord {
	const now = new Date();
	return {
		_id: 'app.customer.com', workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1',
		kind: 'CUSTOM', primary: true, state: 'PENDING', createdAt: now, updatedAt: now,
		...overrides,
	};
}

test('disabled or unconfigured worker is a no-op', async () => {
	const worker = new CfCustomHostnameWorker({ repositories: {} as any, enabled: false });
	assert.deepEqual(await worker.runOnce(), { created: 0, deleted: 0 });
});

test('creates a CF custom hostname for a PENDING host and moves it to ACTIVE', async () => {
	const { worker, rows } = fixture();
	rows.push(host({}));
	await withFetch(async (url) => {
		if (url.toString().includes('/custom_hostnames?hostname=')) return jsonResponse(200, { success: true, result: [] });
		return jsonResponse(200, { success: true, result: { id: 'cf-id-1', hostname: 'app.customer.com' } });
	}, async () => {
		const result = await worker.runOnce();
		assert.equal(result.created, 1);
	});
	assert.equal(rows[0]!.cfHostnameId, 'cf-id-1');
	assert.equal(rows[0]!.state, 'ACTIVE');
});

test('never adopts a foreign CF hostname — FAILED hostname_exists_elsewhere, no id stored', async () => {
	const { worker, rows } = fixture();
	rows.push(host({}));
	await withFetch(async (url) => {
		if (url.toString().includes('/custom_hostnames?hostname=')) {
			return jsonResponse(200, { success: true, result: [{ id: 'someone-elses-id', hostname: 'app.customer.com' }] });
		}
		throw new Error('must not attempt to create when a foreign object already exists');
	}, async () => {
		await worker.runOnce();
	});
	assert.equal(rows[0]!.state, 'FAILED');
	assert.equal(rows[0]!.lastError, 'hostname_exists_elsewhere');
	assert.equal(rows[0]!.cfHostnameId, undefined);
});

test('M4: a lost post-create DB write is repaired by adopting our own tagged CF object, not failed as foreign', async () => {
	const { worker, rows } = fixture();
	rows.push(host({}));
	let createCalled = false;
	await withFetch(async (url, init) => {
		if (url.toString().includes('/custom_hostnames?hostname=')) {
			// The first `create()` call already succeeded on Cloudflare — tagged
			// with our own registry `_id` — but the DB write of `cfHostnameId`
			// never landed, so this row still looks PENDING/untouched to us.
			return jsonResponse(200, {
				success: true,
				result: [{ id: 'cf-id-already-created', hostname: 'app.customer.com', custom_metadata: { privos_registry_id: 'app.customer.com' } }],
			});
		}
		createCalled = true;
		throw new Error('must not attempt a second create when our own tagged object already exists');
	}, async () => {
		const result = await worker.runOnce();
		assert.equal(result.created, 1);
	});
	assert.equal(createCalled, false);
	assert.equal(rows[0]!.cfHostnameId, 'cf-id-already-created');
	assert.equal(rows[0]!.state, 'ACTIVE');
	assert.notEqual(rows[0]!.state, 'FAILED');
});

test('deletes the CF hostname of a DELETING row and removes the row', async () => {
	const { worker, rows } = fixture();
	rows.push(host({ state: 'DELETING', cfHostnameId: 'cf-id-1' }));
	let deletedPath: string | undefined;
	await withFetch(async (url) => {
		deletedPath = url.toString();
		return jsonResponse(200, { success: true, result: {} });
	}, async () => {
		const result = await worker.runOnce();
		assert.equal(result.deleted, 1);
	});
	assert.ok(deletedPath?.includes('/custom_hostnames/cf-id-1'));
	assert.equal(rows.length, 0);
});

test('429/5xx responses back off and retry, eventually succeeding', async () => {
	const { worker, rows } = fixture();
	rows.push(host({}));
	let calls = 0;
	await withFetch(async (url) => {
		if (url.toString().includes('?hostname=')) return jsonResponse(200, { success: true, result: [] });
		calls += 1;
		if (calls < 3) return new Response('rate limited', { status: 429 });
		return jsonResponse(200, { success: true, result: { id: 'cf-id-1', hostname: 'app.customer.com' } });
	}, async () => {
		const result = await worker.runOnce();
		assert.equal(result.created, 1);
	});
	assert.equal(calls, 3);
	assert.equal(rows[0]!.cfHostnameId, 'cf-id-1');
});

test('releaseSuspendedCfHostnames deletes the CF hostname, marks CF_RELEASED, and never touches the label', async () => {
	const { worker, rows } = fixture();
	const wsSuspendedAt = new Date('2025-12-01T00:00:00Z');
	rows.push(host({ state: 'WS_SUSPENDED', cfHostnameId: 'cf-id-1', wsSuspendedAt }));
	const now = new Date('2026-01-31T00:00:00Z');
	await withFetch(async () => jsonResponse(200, { success: true, result: {} }), async () => {
		const result = await worker.releaseSuspendedCfHostnames(30, now);
		assert.equal(result.released, 1);
	});
	assert.equal(rows[0]!.state, 'CF_RELEASED');
	assert.equal(rows[0]!.cfHostnameId, undefined);
});
