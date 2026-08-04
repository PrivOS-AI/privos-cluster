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

test('Hub-facing v3 app views do not expose Cluster-owned replica routing identifiers', async () => {
	const v3App: MasterApp = {
		...mcpApp,
		kind: 'mcp-v3',
		protocolVersion: 3,
		mcpInstallationId: undefined,
		mcpRuntimeInstallationId: 'runtime-1',
		replicas: [{
			replicaId: '11111111-1111-4111-8111-111111111111',
			nodeId: 'node-1',
			containerId: '22222222-2222-4222-8222-222222222222',
			state: 'running',
		}],
	};
	const lifecycle = new AppLifecycleService({
		repositories: { apps: { findOne: async () => v3App } } as never,
		agentClient: {} as never,
		ingress: {} as never,
	});
	const view = await lifecycle.get('workspace-1', 'cluster-app-1') as Record<string, unknown>;
	assert.equal(view.replicaCount, 1);
	assert.equal(view.replicas, undefined);
	await assert.rejects(
		lifecycle.remove('workspace-1', 'cluster-app-1'),
		(error: unknown) =>
			error instanceof Error &&
			(error as Error & { code?: string; statusCode?: number }).code === 'MCP_SIGNED_LIFECYCLE_REQUIRED' &&
			(error as Error & { code?: string; statusCode?: number }).statusCode === 409,
	);
});
