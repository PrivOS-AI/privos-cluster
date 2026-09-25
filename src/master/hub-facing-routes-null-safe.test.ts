/**
 * A + D: the Hub-facing responses that name a public host must OMIT the key
 * entirely for a host-less v3 app (D9 — the Hub `$unset`s its own copy
 * whenever the field is absent), and `subdomain-check` is scoped so a
 * workspace's own already-held label reads as available.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import { hubFacingRoutes } from './hub-facing-routes.js';

/** Mirrors `DeploymentService.publicUrlFor` exactly: undefined in, undefined out. */
function publicUrlFor(subdomain: string | undefined): string | undefined {
	return subdomain ? `https://${subdomain}.apps.example.com` : undefined;
}

test('v3 upgrade response omits publicUrl for a host-less app (D9)', async (t) => {
	const fastify = Fastify();
	t.after(() => fastify.close());
	const runningDigest = `sha256:${'a'.repeat(64)}`;
	const targetDigest = `sha256:${'f'.repeat(64)}`;
	const command = {
		operationId: '55555555-5555-4555-8555-555555555555',
		clusterId: 'cluster-1', workspaceId: 'workspace-1', deploymentId: 'deployment-1',
		generationId: 'generation-1', generationNumber: 1, revision: 1,
		runtimeInstallationId: 'runtime-1', clusterAppId: 'cluster-app-1', mcpAppId: 'mcp-app-1',
		targetManifestDigest: targetDigest, targetImageDigest: targetDigest,
		previousManifestDigest: runningDigest, previousImageDigest: runningDigest,
		resourceManifestHash: 'r'.repeat(43), runtimeResourceInventoryHash: 'i'.repeat(43),
		authorizationEpoch: 7, resultingAuthorizationEpoch: 8, upgradeEpoch: 1,
	};
	await fastify.register(hubFacingRoutes({
		auth: { verify: async (workspaceId: string) => ({ workspaceId }) } as any,
		deployment: {
			publicUrlFor,
			upgradeMcpV3: async () => ({
				// No `subdomain` at all — the MCP_V3_NO_DEFAULT_HOST case.
				app: { appId: 'cluster-app-1', subdomain: undefined, manifestDigest: targetDigest, imageDigest: targetDigest, updatedAt: new Date() },
				swapStrategy: 'STOP_THEN_CREATE',
			}),
		} as any,
		lifecycle: {} as any,
		repositories: {
			apps: { findOne: async () => ({ image: `registry.example/app@${runningDigest}`, workspaceId: 'workspace-1' }) },
			nodes: { findOne: async () => ({ nodeId: 'node-1' }) },
		} as any,
		agentClient: {
			request: async () => ({ status: 200, body: { imageDigest: targetDigest, manifestDigest: targetDigest } }),
		} as any,
		baseDomain: 'apps.example.com',
		mcpSecurity: { consumeUpgradeCommandV3: async () => command as any } as any,
		mcpV2Enabled: false, mcpV3Enabled: true, mcpReconfigureEnabled: true, mcpUpgradeEnabled: true,
		clusterMasterIdentity: {
			signUpgradeAcknowledgement: async () => ({ compact: 'h.p.s', artifactHash: 'A'.repeat(43), kid: 'kid-1' }),
		} as any,
		mcpReleaseAuthorityJwks: [],
	}));
	await fastify.ready();
	const response = await fastify.inject({
		method: 'POST', url: '/w/workspace-1/api/v1/mcp/v3/apps/runtime-1/upgrade',
		headers: { authorization: 'Bearer test' },
		payload: {
			upgradeCommandJws: 'signed', issuer: 'urn:privos:hub:deployment-1', deploymentId: 'deployment-1',
			generationId: 'generation-1', generationNumber: 1, clusterAppId: 'cluster-app-1', mcpAppId: 'mcp-app-1',
			resourceManifestHash: 'r'.repeat(43), runtimeResourceInventoryHash: 'i'.repeat(43),
		},
	});
	assert.equal(response.statusCode, 200);
	const json = response.json();
	assert.equal('publicUrl' in json, false, 'no primary host → the key must be OMITTED entirely');
	assert.ok(!JSON.stringify(json).includes('undefined'));
});

test('subdomain-check reports a HELD label the caller\'s own workspace holds as available', async (t) => {
	const fastify = Fastify();
	t.after(() => fastify.close());
	await fastify.register(hubFacingRoutes({
		auth: { verify: async (workspaceId: string) => ({ workspaceId }) } as any,
		deployment: {} as any,
		lifecycle: {} as any,
		repositories: { apps: { findOne: async () => null } } as any,
		agentClient: {} as any,
		baseDomain: 'apps.example.com',
		mcpV2Enabled: false,
		mcpV3Enabled: false,
		mcpReconfigureEnabled: false,
		mcpUpgradeEnabled: false,
		clusterMasterIdentity: {} as any,
		mcpReleaseAuthorityJwks: [],
		labelNamespace: {
			isAvailableFor: async (label: string, workspaceId: string) => label === 'acme' && workspaceId === 'workspace-1',
		} as any,
	}));
	await fastify.ready();
	const own = await fastify.inject({
		method: 'GET',
		url: '/w/workspace-1/api/v1/cluster/subdomain-check?value=acme',
		headers: { authorization: 'Bearer test' },
	});
	assert.deepEqual(own.json(), { available: true });

	const stranger = await fastify.inject({
		method: 'GET',
		url: '/w/workspace-2/api/v1/cluster/subdomain-check?value=acme',
		headers: { authorization: 'Bearer test' },
	});
	assert.deepEqual(stranger.json(), { available: false });

	const empty = await fastify.inject({
		method: 'GET',
		url: '/w/workspace-1/api/v1/cluster/subdomain-check',
		headers: { authorization: 'Bearer test' },
	});
	assert.deepEqual(empty.json(), { available: false });
});
