import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeWorkspaceUsage } from './workspace-usage-service.js';
import type { Container } from '../types/index.js';

function app(id: string, state: Container['state'], memoryMb: number, cpus: number, volume?: string): Container {
	return {
		id,
		appId: id,
		workspaceId: 'ws-a',
		listingId: `listing-${id}`,
		versionDigest: `sha256:${'a'.repeat(64)}`,
		dockerContainerId: `docker-${id}`,
		dockerContainerName: id,
		image: 'registry/app',
		tag: 'v1',
		state,
		internalUrl: '',
		port: 3000,
		hostPort: null,
		resources: { memoryMb, cpus, tmpSizeMb: 64 },
		envVars: {},
		healthCheck: { status: 'unknown', failCount: 0, restartCount: 0, lastCheck: null },
		createdAt: 1,
		startedAt: null,
		stoppedAt: null,
		volumes: volume ? [{ name: volume, mountPath: '/data' }] : [],
	};
}

test('usage bills reserved labels for running apps and storage for stopped apps', () => {
	const snapshot = summarizeWorkspaceUsage(
		'ws-a',
		[
			app('a', 'running', 512, 0.5, 'vol-a'),
			app('b', 'stopped', 1024, 1, 'vol-b'),
		],
		new Map([['vol-a', 2_000], ['vol-b', 3_000]]),
		new Date('2026-07-28T00:00:00Z'),
	);
	assert.deepEqual(snapshot.totals, {
		runningApps: 1,
		reservedMemoryMb: 512,
		reservedCpus: 0.5,
		volumeBytes: 5_000,
	});
});
