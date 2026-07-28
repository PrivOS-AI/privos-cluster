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
