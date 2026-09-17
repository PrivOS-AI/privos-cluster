import assert from 'node:assert/strict';
import test from 'node:test';

import { QuotaError, QuotaService, STALLED_PROVISIONING_TIMEOUT_MS, isInstalledForQuota } from './quota-service.js';
import type { MasterApp, MasterWorkspace } from './types.js';

const now = new Date('2026-09-17T12:00:00.000Z');
const resources = { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 };

function app(overrides: Partial<MasterApp> = {}): MasterApp {
	return {
		appId: overrides.appId ?? 'app-1',
		workspaceId: 'workspace-1',
		listingId: 'listing-1',
		versionDigest: `sha256:${'a'.repeat(64)}`,
		image: '10.88.0.11:5000/marketplace/app',
		imageDigest: `sha256:${'a'.repeat(64)}`,
		resources,
		port: 3000,
		envVars: {},
		volumes: [],
		storageBytes: 0,
		availabilityTier: 'single',
		stateless: true,
		subdomain: overrides.appId ?? 'app-1',
		uiUrl: 'https://app-1.example.test',
		// Stop/quarantine/provisioning all retain the replica record (only its
		// per-replica `state` changes) — an empty array would zero out the
		// memory/cpu usage sum regardless of app-level state, which is not
		// what quota-service computes from a real document.
		replicas: [{ replicaId: 'replica-1', nodeId: 'node-1', containerId: 'container-1', state: 'running' }],
		state: 'RUNNING',
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function workspace(overrides: Partial<MasterWorkspace> = {}): MasterWorkspace {
	return {
		workspaceId: 'workspace-1',
		keyHash: 'hash',
		encryptedKey: 'enc',
		quota: { maxMemoryMb: 100_000, maxCpus: 100, maxApps: 100 },
		defaultAvailabilityTier: 'single',
		status: 'ACTIVE',
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

/** Minimal Mongo-shaped fake: only the query shapes quota-service actually issues. */
function fakeRepositories(ws: MasterWorkspace | undefined, apps: MasterApp[]) {
	return {
		workspaces: { findOne: async () => ws },
		apps: {
			find: (query: { workspaceId: string; state?: { $in: string[] } }) => ({
				toArray: async () => apps.filter((a) =>
					a.workspaceId === query.workspaceId && (!query.state || query.state.$in.includes(a.state))),
			}),
		},
	} as never;
}

test('isInstalledForQuota: RUNNING and STOPPED count', () => {
	assert.equal(isInstalledForQuota(app({ state: 'RUNNING' }), now), true);
	assert.equal(isInstalledForQuota(app({ state: 'STOPPED' }), now), true);
});

test('isInstalledForQuota: pre-activation QUARANTINED (no quarantinedAt) counts', () => {
	assert.equal(isInstalledForQuota(app({ state: 'QUARANTINED', quarantinedAt: undefined }), now), true);
});

test('isInstalledForQuota: revoke QUARANTINED (quarantinedAt set) does not count', () => {
	assert.equal(isInstalledForQuota(app({ state: 'QUARANTINED', quarantinedAt: now }), now), false);
});

test('isInstalledForQuota: fresh PROVISIONING counts, stale PROVISIONING does not', () => {
	const fresh = app({ state: 'PROVISIONING', createdAt: new Date(now.getTime() - 1_000) });
	const stale = app({ state: 'PROVISIONING', createdAt: new Date(now.getTime() - STALLED_PROVISIONING_TIMEOUT_MS - 1) });
	assert.equal(isInstalledForQuota(fresh, now), true);
	assert.equal(isInstalledForQuota(stale, now), false);
});

test('isInstalledForQuota: REMOVED and REMOVING never count', () => {
	assert.equal(isInstalledForQuota(app({ state: 'REMOVED' }), now), false);
	assert.equal(isInstalledForQuota(app({ state: 'REMOVING' }), now), false);
});

test('assertDeployAllowed: a STOPPED app consumes memory/cpu quota', async () => {
	const quota = new QuotaService(fakeRepositories(
		workspace({ quota: { maxMemoryMb: 300, maxCpus: 1, maxApps: 10 } }),
		[app({ state: 'STOPPED', resources: { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 } })],
	));
	await assert.rejects(
		quota.assertDeployAllowed('workspace-1', { memoryMb: 100, cpus: 0.1, tmpSizeMb: 0 }, 1),
		(error: unknown) => error instanceof QuotaError && error.code === 'MEMORY_QUOTA_EXCEEDED',
	);
});

test('assertDeployAllowed: a pre-activation QUARANTINED app consumes quota', async () => {
	const quota = new QuotaService(fakeRepositories(
		workspace({ quota: { maxMemoryMb: 300, maxCpus: 1, maxApps: 10 } }),
		[app({ state: 'QUARANTINED', quarantinedAt: undefined, resources: { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 } })],
	));
	await assert.rejects(
		quota.assertDeployAllowed('workspace-1', { memoryMb: 100, cpus: 0.1, tmpSizeMb: 0 }, 1),
		(error: unknown) => error instanceof QuotaError && error.code === 'MEMORY_QUOTA_EXCEEDED',
	);
});

test('assertDeployAllowed: a revoke-QUARANTINED app does not consume quota', async () => {
	const quota = new QuotaService(fakeRepositories(
		workspace({ quota: { maxMemoryMb: 300, maxCpus: 1, maxApps: 10 } }),
		[app({ state: 'QUARANTINED', quarantinedAt: now, resources: { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 } })],
	));
	await assert.doesNotReject(quota.assertDeployAllowed('workspace-1', { memoryMb: 100, cpus: 0.1, tmpSizeMb: 0 }, 1));
});

test('assertDeployAllowed: a stale PROVISIONING app does not consume quota', async () => {
	// assertDeployAllowed reads the real wall clock internally, so the fixture's
	// createdAt must be relative to actual Date.now() at test time, not the
	// fixed `now` constant used elsewhere in this file.
	const quota = new QuotaService(fakeRepositories(
		workspace({ quota: { maxMemoryMb: 300, maxCpus: 1, maxApps: 10 } }),
		[app({
			state: 'PROVISIONING',
			createdAt: new Date(Date.now() - STALLED_PROVISIONING_TIMEOUT_MS - 1_000),
			resources: { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 },
		})],
	));
	await assert.doesNotReject(quota.assertDeployAllowed('workspace-1', { memoryMb: 100, cpus: 0.1, tmpSizeMb: 0 }, 1));
});

test('assertDeployAllowed: a fresh PROVISIONING app consumes quota', async () => {
	const quota = new QuotaService(fakeRepositories(
		workspace({ quota: { maxMemoryMb: 300, maxCpus: 1, maxApps: 10 } }),
		[app({
			state: 'PROVISIONING',
			createdAt: new Date(Date.now() - 1_000),
			resources: { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 },
		})],
	));
	await assert.rejects(
		quota.assertDeployAllowed('workspace-1', { memoryMb: 100, cpus: 0.1, tmpSizeMb: 0 }, 1),
		(error: unknown) => error instanceof QuotaError && error.code === 'MEMORY_QUOTA_EXCEEDED',
	);
});

test('assertDeployAllowed: app-count quota uses the same installed set', async () => {
	const quota = new QuotaService(fakeRepositories(
		workspace({ quota: { maxMemoryMb: 100_000, maxCpus: 100, maxApps: 2 } }),
		[
			app({ appId: 'running', state: 'RUNNING' }),
			app({ appId: 'stopped', state: 'STOPPED' }),
			// Excluded from the installed set — must not push the count over maxApps.
			app({ appId: 'revoked', state: 'QUARANTINED', quarantinedAt: now }),
			app({ appId: 'stale', state: 'PROVISIONING', createdAt: new Date(Date.now() - STALLED_PROVISIONING_TIMEOUT_MS - 1_000) }),
		],
	));
	// Exactly at the 2-app cap (running + stopped) — a third installed app must be rejected.
	await assert.rejects(
		quota.assertDeployAllowed('workspace-1', { memoryMb: 1, cpus: 0.01, tmpSizeMb: 0 }, 1),
		(error: unknown) => error instanceof QuotaError && error.code === 'APP_QUOTA_EXCEEDED',
	);
});

test('assertResizeAllowed: a resize within headroom succeeds even at the maxApps cap (resize is not a new app)', async () => {
	const target = app({ appId: 'target', resources: { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 } });
	const quota = new QuotaService(fakeRepositories(
		workspace({ quota: { maxMemoryMb: 1024, maxCpus: 4, maxApps: 1 } }),
		[target],
	));
	// The workspace is already at its 1-app cap with only the app being resized —
	// assertResizeAllowed must never apply the maxApps test to its own app.
	await assert.doesNotReject(quota.assertResizeAllowed('workspace-1', target, { memoryMb: 512, cpus: 0.5, tmpSizeMb: 64 }));
});

test('assertResizeAllowed: checks only the DELTA between new and current resources against remaining headroom', async () => {
	const target = app({ appId: 'target', resources: { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 } });
	const quota = new QuotaService(fakeRepositories(
		workspace({ quota: { maxMemoryMb: 300, maxCpus: 1, maxApps: 10 } }),
		[target],
	));
	// used=256, headroom to 300 is 44MB — a 44MB delta fits exactly.
	await assert.doesNotReject(quota.assertResizeAllowed('workspace-1', target, { memoryMb: 300, cpus: 0.25, tmpSizeMb: 64 }));
	// A 45MB delta overshoots by 1MB.
	await assert.rejects(
		quota.assertResizeAllowed('workspace-1', target, { memoryMb: 301, cpus: 0.25, tmpSizeMb: 64 }),
		(error: unknown) => error instanceof QuotaError && error.code === 'MEMORY_QUOTA_EXCEEDED',
	);
});

test('assertResizeAllowed: a cpu delta over the workspace headroom is refused', async () => {
	const target = app({ appId: 'target', resources: { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 } });
	const quota = new QuotaService(fakeRepositories(
		workspace({ quota: { maxMemoryMb: 100_000, maxCpus: 0.5, maxApps: 10 } }),
		[target],
	));
	await assert.rejects(
		quota.assertResizeAllowed('workspace-1', target, { memoryMb: 256, cpus: 1, tmpSizeMb: 64 }),
		(error: unknown) => error instanceof QuotaError && error.code === 'CPU_QUOTA_EXCEEDED',
	);
});

test('assertResizeAllowed: the delta multiplies by replica count for an HA app', async () => {
	const target = app({
		appId: 'target',
		resources: { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 },
		availabilityTier: 'ha',
		replicas: [
			{ replicaId: 'replica-1', nodeId: 'node-1', containerId: 'container-1', state: 'running' },
			{ replicaId: 'replica-2', nodeId: 'node-2', containerId: 'container-2', state: 'running' },
		],
	});
	const quota = new QuotaService(fakeRepositories(
		// used = 256*2 = 512; a +100MB/replica resize needs 200MB more headroom.
		workspace({ quota: { maxMemoryMb: 512 + 199, maxCpus: 4, maxApps: 10 } }),
		[target],
	));
	await assert.rejects(
		quota.assertResizeAllowed('workspace-1', target, { memoryMb: 356, cpus: 0.25, tmpSizeMb: 64 }),
		(error: unknown) => error instanceof QuotaError && error.code === 'MEMORY_QUOTA_EXCEEDED',
	);
});

test('assertAdditionalReplicaAllowed: uses the installed set for memory/cpu too', async () => {
	const quota = new QuotaService(fakeRepositories(
		workspace({ quota: { maxMemoryMb: 300, maxCpus: 1, maxApps: 10 } }),
		[app({ state: 'STOPPED', resources: { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 } })],
	));
	await assert.rejects(
		quota.assertAdditionalReplicaAllowed('workspace-1', { memoryMb: 100, cpus: 0.1, tmpSizeMb: 0 }),
		(error: unknown) => error instanceof QuotaError && error.code === 'MEMORY_QUOTA_EXCEEDED',
	);
});
