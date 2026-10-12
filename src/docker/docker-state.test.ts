import assert from 'node:assert/strict';
import { test } from 'node:test';

import { config } from '../config.js';
import { containerManager } from './index.js';
import { getById, isEligibleForLegacyHostFallback } from './docker-state.js';
import type { Container } from '../types/index.js';

function fakeContainer(overrides: Partial<Container> = {}): Container {
	return {
		id: 'c1', appId: null, workspaceId: null, listingId: null, versionDigest: null,
		dockerContainerId: 'd1', dockerContainerName: 'whoami-abc',
		image: 'traefik/whoami', tag: 'latest', imageDigest: null,
		state: 'running', internalUrl: 'http://localhost:49155',
		port: 3001, hostPort: 49155, resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 }, envVars: {},
		healthCheck: { status: 'healthy', failCount: 0, restartCount: 0, lastCheck: null },
		createdAt: 1, startedAt: null, stoppedAt: null, volumes: [], subdomain: 'whoami', domain: 'privos.link',
		...overrides,
	};
}

test('isEligibleForLegacyHostFallback: v3 (schema=3) containers are excluded — plain/v2 stays eligible', () => {
	assert.equal(isEligibleForLegacyHostFallback(fakeContainer({ mcpV3: true })), false, 'v3 must never resurface through the legacy fallback');
	assert.equal(isEligibleForLegacyHostFallback(fakeContainer({ mcpV3: false })), true);
	assert.equal(isEligibleForLegacyHostFallback(fakeContainer({ mcpV2: true, mcpV3: false })), true, 'v2 (schema=2) is unaffected');
	assert.equal(isEligibleForLegacyHostFallback(fakeContainer()), true, 'plain (no mcp schema) is unaffected — byte-identical default');
});

/** Minimal `docker ps` entries; the fake honours the `label=k=v` filters like the daemon does. */
const entries = [
	{ Id: 'd-a', Names: ['/app-a'], Image: 'img:1', State: 'running', Created: 1, Labels: { 'privos.managed': 'true', 'privos.id': 'shared-id', 'privos.workspace': 'ws-a' } },
	{ Id: 'd-b', Names: ['/app-b'], Image: 'img:1', State: 'running', Created: 2, Labels: { 'privos.managed': 'true', 'privos.id': 'only-b', 'privos.workspace': 'ws-b' } },
	{ Id: 'd-self', Names: ['/self'], Image: 'img:1', State: 'running', Created: 3, Labels: { 'privos.managed': 'true', 'privos.id': 'self-hosted' } },
];

async function withFakeDocker(fleet: boolean, run: () => Promise<void>): Promise<void> {
	const manager = containerManager as unknown as { listContainers: unknown };
	const savedList = manager.listContainers;
	const savedFleet = config.FLEET_MODE;
	manager.listContainers = async (filters: Record<string, string[]> = {}) =>
		entries.filter((entry) =>
			(filters.label ?? []).every((pair) => {
				const [key, ...rest] = pair.split('=');
				return entry.Labels[key as keyof typeof entry.Labels] === rest.join('=');
			}));
	config.FLEET_MODE = fleet;
	try {
		await run();
	} finally {
		manager.listContainers = savedList;
		config.FLEET_MODE = savedFleet;
	}
}

test('getById in fleet mode refuses a lookup without a workspace', async () => {
	await withFakeDocker(true, async () => {
		await assert.rejects(() => getById('shared-id'), /workspace scope required/);
		await assert.rejects(() => getById('shared-id', undefined, ''), /workspace scope required/);
	});
});

test('getById in fleet mode never returns another workspace\'s container', async () => {
	await withFakeDocker(true, async () => {
		assert.equal((await getById('shared-id', undefined, 'ws-a'))?.dockerContainerId, 'd-a');
		assert.equal(await getById('shared-id', undefined, 'ws-b'), null);
		assert.equal(await getById('only-b', undefined, 'ws-a'), null);
	});
});

test('getById outside fleet mode stays unscoped', async () => {
	await withFakeDocker(false, async () => {
		assert.equal((await getById('self-hosted'))?.dockerContainerId, 'd-self');
		assert.equal((await getById('shared-id'))?.dockerContainerId, 'd-a');
		assert.equal(await getById('shared-id', undefined, 'ws-b'), null, 'an explicit workspace still scopes');
	});
});
