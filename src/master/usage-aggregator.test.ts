import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateWorkspaceDay } from './usage-aggregator.js';
import type { AppLifecycleEvent, MasterApp } from './types.js';

const day = new Date('2026-07-28T00:00:00.000Z');
const atHour = (hour: number) => new Date(day.getTime() + hour * 3_600_000);
const resources = { memoryMb: 512, cpus: 0.5, tmpSizeMb: 64 };

function app(overrides: Partial<MasterApp> = {}): MasterApp {
	return {
		appId: 'app-1',
		workspaceId: 'ws-1',
		listingId: 'listing-1',
		versionDigest: `sha256:${'a'.repeat(64)}`,
		image: '10.88.0.11:5000/marketplace/app',
		imageDigest: `sha256:${'a'.repeat(64)}`,
		resources,
		port: 3001,
		envVars: {},
		volumes: [{ name: 'data', mountPath: '/data', sizeMb: 2048 }],
		storageBytes: 2 * 1024 ** 3,
		availabilityTier: 'single',
		stateless: false,
		subdomain: 'app-1',
		uiUrl: 'https://app-1.privos.link',
		replicas: [],
		state: 'RUNNING',
		createdAt: day,
		updatedAt: day,
		...overrides,
	};
}

function event(replicaId: string, type: AppLifecycleEvent['type'], at: Date): AppLifecycleEvent {
	return { eventId: `${replicaId}-${type}-${at.toISOString()}`, workspaceId: 'ws-1', appId: 'app-1', replicaId, type, resources, at };
}

let appEventSeq = 0;
/** An app-level billing event (INSTALLED/UNINSTALLED/REPLICAS_CHANGED, or a
 * revoke-teardown QUARANTINED) — no replicaId, unlike the per-replica `event`
 * helper above. */
function appEvent(
	type: 'INSTALLED' | 'UNINSTALLED' | 'REPLICAS_CHANGED' | 'QUARANTINED' | 'RESIZED',
	at: Date,
	overrides: Partial<AppLifecycleEvent> = {},
): AppLifecycleEvent {
	appEventSeq += 1;
	return { eventId: `app-event-${appEventSeq}`, workspaceId: 'ws-1', appId: 'app-1', type, resources, at, ...overrides };
}

test('a 512MB/0.5cpu app running 24h attributes exact reserved app-hours', () => {
	const usage = aggregateWorkspaceDay('ws-1', day, [event('replica-1', 'STARTED', day)], [app()]);
	assert.equal(usage.ramGbHours, 12);
	assert.equal(usage.cpuHours, 12);
	assert.equal(usage.storageGbDay, 2);
});

test('a stopped app bills compute only while running and storage until removal', () => {
	const usage = aggregateWorkspaceDay('ws-1', day, [
		event('replica-1', 'STARTED', day),
		event('replica-1', 'STOPPED', atHour(6)),
		event('replica-1', 'REMOVED', atHour(18)),
	], [app()]);
	assert.equal(usage.ramGbHours, 3);
	assert.equal(usage.cpuHours, 3);
	assert.equal(usage.storageGbDay, 1.5);
});

test('HA bills each replica compute while counting shared stateless storage once', () => {
	const usage = aggregateWorkspaceDay('ws-1', day, [
		event('replica-1', 'STARTED', day),
		event('replica-2', 'STARTED', day),
	], [app({ availabilityTier: 'ha', stateless: true })]);
	assert.equal(usage.ramGbHours, 24);
	assert.equal(usage.cpuHours, 24);
	assert.equal(usage.storageGbDay, 2);
});

test('an in-progress UTC day is metered only through the rollup timestamp', () => {
	const usage = aggregateWorkspaceDay(
		'ws-1',
		day,
		[event('replica-1', 'STARTED', atHour(20))],
		[app({ createdAt: atHour(20) })],
		atHour(21),
	);
	assert.equal(usage.ramGbHours, 0.5);
	assert.equal(usage.cpuHours, 0.5);
	assert.equal(usage.storageGbDay, 2 / 24);
});

test('an app installed mid-day bills a day fraction below 1', () => {
	const usage = aggregateWorkspaceDay('ws-1', day, [appEvent('INSTALLED', atHour(6), { replicaCount: 1 })], []);
	const row = usage.perApp.find((entry) => entry.appId === 'app-1')!;
	assert.equal(row.installedDayFraction, 18 / 24);
	assert.equal(row.replicaCount, 1);
	assert.deepEqual(row.resources, resources);
});

test('an app uninstalled mid-day stops billing at the UNINSTALLED event', () => {
	const usage = aggregateWorkspaceDay('ws-1', day, [
		appEvent('INSTALLED', day, { replicaCount: 1 }),
		appEvent('UNINSTALLED', atHour(6)),
	], []);
	const row = usage.perApp.find((entry) => entry.appId === 'app-1')!;
	assert.equal(row.installedDayFraction, 6 / 24);
});

test('a same-day reinstall sums both installed segments and bills storage for both (reinstall no longer bills $0)', () => {
	const storageBytes = 2 * 1024 ** 3;
	const usage = aggregateWorkspaceDay('ws-1', day, [
		appEvent('INSTALLED', day, { replicaCount: 1, storageBytes }),
		appEvent('UNINSTALLED', atHour(6)),
		appEvent('INSTALLED', atHour(12), { replicaCount: 1, storageBytes }),
		appEvent('UNINSTALLED', atHour(18)),
	], []);
	const row = usage.perApp.find((entry) => entry.appId === 'app-1')!;
	assert.equal(row.installedDayFraction, 12 / 24);
	assert.ok(row.storageGbDay > 0);
	assert.equal(row.storageGbDay, 1);
});

test('a reinstall next month bills each month independently — no permanent $0 after the first removal', () => {
	const nextMonthDay = new Date('2026-08-05T00:00:00.000Z');
	const events = [
		appEvent('INSTALLED', day, { replicaCount: 1 }),
		appEvent('UNINSTALLED', atHour(12)),
		appEvent('INSTALLED', new Date(nextMonthDay.getTime() + 3 * 3_600_000), { replicaCount: 1 }),
	];
	const thisMonth = aggregateWorkspaceDay('ws-1', day, events, []);
	const nextMonth = aggregateWorkspaceDay('ws-1', nextMonthDay, events, []);
	assert.equal(thisMonth.perApp.find((entry) => entry.appId === 'app-1')!.installedDayFraction, 12 / 24);
	assert.equal(nextMonth.perApp.find((entry) => entry.appId === 'app-1')!.installedDayFraction, 21 / 24);
});

test('a deploy that never activates is never billed', () => {
	const usage = aggregateWorkspaceDay('ws-1', day, [], [app({ state: 'PROVISIONING' })]);
	assert.equal(usage.perApp.find((entry) => entry.appId === 'app-1'), undefined);
});

test('HA to single via REPLICAS_CHANGED keeps billing across the tier change, now at 1 replica', () => {
	const usage = aggregateWorkspaceDay('ws-1', day, [
		appEvent('INSTALLED', new Date(day.getTime() - 24 * 3_600_000), { replicaCount: 2 }),
		appEvent('REPLICAS_CHANGED', day, { replicaCount: 1 }),
	], []);
	const row = usage.perApp.find((entry) => entry.appId === 'app-1')!;
	assert.equal(row.installedDayFraction, 1);
	assert.equal(row.replicaCount, 1);
});

test('a RESIZED mid-day re-bases the segment resources without changing replicaCount or closing the interval', () => {
	const smaller = { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 };
	const larger = { memoryMb: 1024, cpus: 1, tmpSizeMb: 64 };
	const usage = aggregateWorkspaceDay('ws-1', day, [
		appEvent('INSTALLED', day, { replicaCount: 1, resources: smaller }),
		appEvent('RESIZED', atHour(12), { resources: larger }),
	], []);
	const row = usage.perApp.find((entry) => entry.appId === 'app-1')!;
	// Installed the whole day, uninterrupted — a resize re-bases the OPEN
	// interval, it never closes/reopens it the way REPLICAS_CHANGED's example
	// above also doesn't.
	assert.equal(row.installedDayFraction, 1);
	assert.equal(row.replicaCount, 1);
	// A resize day is priced at the largest resources held that day — the max
	// across segments, never a time-weighted average.
	assert.deepEqual(row.resources, larger);
});

test('an HA app installed with 2 replicas bills replicaCount 2', () => {
	const usage = aggregateWorkspaceDay('ws-1', day, [appEvent('INSTALLED', day, { replicaCount: 2 })], []);
	const row = usage.perApp.find((entry) => entry.appId === 'app-1')!;
	assert.equal(row.replicaCount, 2);
	assert.equal(row.installedDayFraction, 1);
});

test('a revoke stops billing at the QUARANTINED event, not at the later reap', () => {
	const reapDate = new Date(day.getTime() + 7 * 24 * 3_600_000);
	const events = [
		appEvent('INSTALLED', day, { replicaCount: 1 }),
		appEvent('QUARANTINED', atHour(6)),
		appEvent('UNINSTALLED', reapDate), // reap's destroy(), 7 days later
	];
	const revokedDay = aggregateWorkspaceDay('ws-1', day, events, []);
	const reapDay = aggregateWorkspaceDay('ws-1', reapDate, events, []);
	assert.equal(revokedDay.perApp.find((entry) => entry.appId === 'app-1')!.installedDayFraction, 6 / 24);
	assert.equal(reapDay.perApp.find((entry) => entry.appId === 'app-1'), undefined);
});

test('un-quarantine re-opens the interval a revoke closed', () => {
	const usage = aggregateWorkspaceDay('ws-1', day, [
		appEvent('INSTALLED', day, { replicaCount: 1 }),
		appEvent('QUARANTINED', atHour(6)),
		appEvent('INSTALLED', atHour(10), { replicaCount: 1 }),
	], []);
	const row = usage.perApp.find((entry) => entry.appId === 'app-1')!;
	assert.equal(row.installedDayFraction, (6 + 14) / 24);
});

test('a legacy app with no app-level events falls back to [createdAt, removal)', () => {
	const usage = aggregateWorkspaceDay(
		'ws-1',
		day,
		[event('replica-1', 'STARTED', atHour(6))],
		[app({ createdAt: atHour(6) })],
	);
	const row = usage.perApp.find((entry) => entry.appId === 'app-1')!;
	assert.equal(row.installedDayFraction, 18 / 24);
	assert.equal(row.replicaCount, 1);
	assert.deepEqual(row.resources, { memoryMb: 512, cpus: 0.5, tmpSizeMb: 64 });
	assert.ok(row.storageGbDay > 0);
});

test('legacy fallback ignores a stale REMOVED from before a tombstone revive (reinstall no longer bills $0 forever)', () => {
	const staleRemovedAt = new Date(day.getTime() - 24 * 3_600_000);
	const usage = aggregateWorkspaceDay(
		'ws-1',
		day,
		[
			event('replica-1', 'STARTED', day),
			event('replica-1', 'REMOVED', staleRemovedAt), // from this appId's previous life, before the revive
		],
		[app({ createdAt: day })], // revived today: fresh createdAt, after the stale removal
	);
	const row = usage.perApp.find((entry) => entry.appId === 'app-1')!;
	assert.equal(row.installedDayFraction, 1);
	assert.ok(row.storageGbDay > 0);
});
