import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isEligibleForLegacyHostFallback } from './docker-state.js';
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
