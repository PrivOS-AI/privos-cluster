import assert from 'node:assert/strict';
import test from 'node:test';

import { AppLifecycleService } from './app-lifecycle-service.js';
import type { MasterApp } from './types.js';

const mcpApp: MasterApp = {
	appId: 'cluster-app-1',
	workspaceId: 'workspace-1',
	listingId: 'listing-1',
	versionDigest: 'sha256:version',
	image: 'registry.internal/example@sha256:image',
	imageDigest: 'sha256:image',
	resources: { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 },
	port: 3000,
	envVars: {},
	volumes: [],
	storageBytes: 0,
	availabilityTier: 'single',
	stateless: true,
	subdomain: 'mcp-app-1',
	uiUrl: 'https://mcp-app-1.example.test',
	replicas: [],
	state: 'RUNNING',
	createdAt: new Date('2026-08-02T00:00:00.000Z'),
	updatedAt: new Date('2026-08-02T00:00:00.000Z'),
	kind: 'mcp-v2',
	mcpInstallationId: 'installation-1',
};

test('generic redeploy cannot mutate an MCP v2 workload without a signed grant', async () => {
	const lifecycle = new AppLifecycleService({
		repositories: {
			apps: { findOne: async () => mcpApp },
		} as never,
		agentClient: {} as never,
		ingress: {} as never,
	});

	await assert.rejects(
		lifecycle.redeploy('workspace-1', 'cluster-app-1', { image: 'attacker.invalid/latest' }),
		(error: unknown) =>
			error instanceof Error &&
			(error as Error & { code?: string; statusCode?: number }).code === 'MCP_SIGNED_REDEPLOYMENT_REQUIRED' &&
			(error as Error & { code?: string; statusCode?: number }).statusCode === 409,
	);
});
