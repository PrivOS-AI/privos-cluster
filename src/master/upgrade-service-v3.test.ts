/**
 * In-place image upgrade: the revision/epoch guard, the previous-digest
 * affinity that names the revert target (D4), and the swap delegated to the
 * agent's existing redeploy primitive rather than a second code path.
 *
 * The threat this closes is the same class as reconfigure's: a redelivered or
 * forged command must never re-run, silently skip, or partially apply a swap,
 * and a failed swap must never leave the generation's bookkeeping claiming an
 * image that isn't actually running.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DeploymentService } from './deployment-service.js';
import { KeyCipher } from './key-crypto.js';
import { McpProtocolV3Error, type ClusterUpgradeCommandPayloadV3 } from './protocol-v3.js';
import type { MasterApp, MasterNode } from './types.js';

const CIPHER_KEY = Buffer.alloc(32, 9);

function runningApp(overrides: Partial<MasterApp> = {}): MasterApp {
	const now = new Date();
	return {
		appId: 'cluster-app-1',
		workspaceId: 'workspace-1',
		listingId: 'listing-1',
		versionDigest: `sha256:${'d'.repeat(64)}`,
		image: `registry.example/app@sha256:${'e'.repeat(64)}`,
		imageDigest: `sha256:${'e'.repeat(64)}`,
		resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 },
		port: 3001,
		envVars: {},
		volumes: [],
		storageBytes: 0,
		availabilityTier: 'single',
		stateless: true,
		subdomain: 'library-app',
		uiUrl: 'https://library-app.apps.example.com',
		appliedConfigEpoch: 1,
		appliedConfigAt: now,
		replicas: [{ replicaId: 'replica-1', nodeId: 'node-1', containerId: 'container-1', state: 'running' }],
		state: 'RUNNING',
		kind: 'mcp-v3',
		protocolVersion: 3,
		mcpDeploymentId: 'deployment-1',
		mcpActiveDeploymentKey: 'deployment-1',
		mcpGenerationId: 'generation-1',
		mcpGenerationNumber: 1,
		mcpRuntimeInstallationId: 'runtime-1',
		mcpDeploymentGrantJti: '11111111-1111-4111-8111-111111111111',
		mcpDeploymentGrantHash: 'g'.repeat(43),
		mcpAppId: 'mcp-app-1',
		manifestDigest: `sha256:${'e'.repeat(64)}`,
		resourceManifestHash: 'r'.repeat(43),
		mcpApprovalReceiptHash: 'b'.repeat(43),
		mcpApprovedPermissionCeilingHash: 'c'.repeat(43),
		mcpAuthorizationEpoch: 7,
		runtimeResourceInventoryHash: 'i'.repeat(43),
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function command(overrides: Partial<ClusterUpgradeCommandPayloadV3> = {}): ClusterUpgradeCommandPayloadV3 {
	const now = Math.floor(Date.now() / 1000);
	return {
		protocolVersion: 3,
		type: 'cluster-upgrade-command',
		iss: 'urn:privos:hub:deployment-1',
		aud: 'privos-apps-master',
		jti: '22222222-2222-4222-8222-222222222222',
		nonce: 'upgrade-nonce-123456789012',
		iat: now,
		exp: now + 300,
		action: 'UPGRADE_RUNTIME',
		operationId: '33333333-3333-4333-8333-333333333333',
		clusterId: 'cluster-1',
		workspaceId: 'workspace-1',
		deploymentId: 'deployment-1',
		generationId: 'generation-1',
		generationNumber: 1,
		revision: 1,
		runtimeInstallationId: 'runtime-1',
		clusterAppId: 'cluster-app-1',
		mcpAppId: 'mcp-app-1',
		targetManifestDigest: `sha256:${'f'.repeat(64)}`,
		targetImageDigest: `sha256:${'f'.repeat(64)}`,
		previousManifestDigest: `sha256:${'e'.repeat(64)}`,
		previousImageDigest: `sha256:${'e'.repeat(64)}`,
		resourceManifestHash: 'r'.repeat(43),
		runtimeResourceInventoryHash: 'i'.repeat(43),
		authorizationEpoch: 7,
		resultingAuthorizationEpoch: 8,
		upgradeEpoch: 1,
		...overrides,
	};
}

function fixture(app: MasterApp = runningApp(), agentResponses?: (path: string) => { status: number; body: unknown }) {
	const apps = [structuredClone(app)];
	const nodes: MasterNode[] = [{
		nodeId: 'node-1', url: 'https://node-1.internal', region: 'eu', failureDomain: 'fd-1',
		capacity: { memoryMb: 4096, cpus: 4, diskBytes: 10_000_000_000 }, status: 'ACTIVE',
		keyId: 'key-1', encryptedFleetKey: 'encrypted-1', createdAt: new Date(), updatedAt: new Date(),
	}, {
		nodeId: 'node-2', url: 'https://node-2.internal', region: 'eu', failureDomain: 'fd-2',
		capacity: { memoryMb: 4096, cpus: 4, diskBytes: 10_000_000_000 }, status: 'ACTIVE',
		keyId: 'key-2', encryptedFleetKey: 'encrypted-2', createdAt: new Date(), updatedAt: new Date(),
	}];
	const agentCalls: Array<{ path: string; body: any }> = [];
	const service = new DeploymentService({
		repositories: {
			apps: {
				findOne: async (filter: any) => {
					const found = apps[0];
					if (!found) return null;
					if (filter.workspaceId && found.workspaceId !== filter.workspaceId) return null;
					if (filter.mcpRuntimeInstallationId && found.mcpRuntimeInstallationId !== filter.mcpRuntimeInstallationId) return null;
					return structuredClone(found);
				},
				updateOne: async (filter: any, update: any) => {
					const applied = apps[0]!.mcpAppliedRevision ?? 0;
					if (filter.mcpAppliedRevision?.$lt !== undefined && !(applied < filter.mcpAppliedRevision.$lt)) {
						return { matchedCount: 0 };
					}
					Object.assign(apps[0]!, structuredClone(update.$set ?? {}));
					return { matchedCount: 1 };
				},
			},
			nodes: { find: () => ({ toArray: async () => structuredClone(nodes) }) },
		} as any,
		agentClient: {
			request: async (_node: MasterNode, _ws: string, _method: string, path: string, body: any) => {
				agentCalls.push({ path, body });
				return agentResponses?.(path) ?? { status: 200, body: { swapStrategy: 'STOP_THEN_CREATE' } };
			},
		} as any,
		ingress: {} as any,
		quota: {} as any,
		subdomains: {} as any,
		locks: { run: async (_ws: string, work: () => Promise<unknown>) => work() } as any,
		baseDomain: 'apps.example.com',
		cipher: new KeyCipher(CIPHER_KEY),
	});
	return { apps, agentCalls, service };
}

test('a verified upgrade swaps every replica through the existing redeploy primitive and persists the new digests', async () => {
	const state = fixture();
	const result = await state.service.upgradeMcpV3('workspace-1', command());

	assert.equal(state.agentCalls.length, 1);
	const [call] = state.agentCalls;
	assert.equal(call!.path, '/api/v1/apps/container-1/redeploy');
	assert.equal(call!.body.digest, `sha256:${'f'.repeat(64)}`);
	assert.equal(call!.body.mcpV3Binding.manifestDigest, `sha256:${'f'.repeat(64)}`);
	assert.equal(call!.body.mcpV3Binding.imageDigest, `sha256:${'f'.repeat(64)}`);
	// Everything about permissions/resources travels UNCHANGED (D1) — not renegotiated here.
	assert.equal(call!.body.mcpV3Binding.approvalReceiptHash, 'b'.repeat(43));
	// The container is labelled with the epoch it will have to attest with AFTER
	// the swap (8), not the one being retired (7). Labelling the retired epoch is
	// what left every upgraded runtime permanently unpairable against a Hub that
	// had already rotated to 8.
	assert.equal(call!.body.mcpV3Binding.authorizationEpoch, 8);
	assert.equal(call!.body.mcpV3Binding.resourceManifestHash, 'r'.repeat(43));
	assert.equal(call!.body.runtimeResourceInventoryHash, 'i'.repeat(43));

	assert.equal(result.swapStrategy, 'STOP_THEN_CREATE');
	assert.equal(result.app.manifestDigest, `sha256:${'f'.repeat(64)}`);
	assert.equal(result.app.imageDigest, `sha256:${'f'.repeat(64)}`);
	assert.equal(result.app.mcpPreviousManifestDigest, `sha256:${'e'.repeat(64)}`);
	assert.equal(result.app.mcpPreviousImageDigest, `sha256:${'e'.repeat(64)}`);
	assert.equal(result.app.mcpAppliedRevision, 1);
	assert.equal(result.app.mcpAppliedUpgradeEpoch, 1);
	assert.equal(result.app.mcpLastSwapStrategy, 'STOP_THEN_CREATE');
	// The stored epoch moves with the labels. It is what the NEXT upgrade's
	// affinity check compares against and what hub-facing dispatch hands back as
	// `runtimeGrantEpoch`; leaving it on 7 would desynchronize both from the
	// container that is now attesting 8.
	assert.equal(result.app.mcpAuthorizationEpoch, 8);
});

test('the rolling strategy the agent reports is threaded through untouched', async () => {
	const state = fixture(runningApp(), () => ({ status: 200, body: { swapStrategy: 'ROLLING' } }));
	const result = await state.service.upgradeMcpV3('workspace-1', command());
	assert.equal(result.swapStrategy, 'ROLLING');
	assert.equal(state.apps[0]!.mcpLastSwapStrategy, 'ROLLING');
});

test('a command naming another generation cannot reach this runtime', async () => {
	const state = fixture();
	await assert.rejects(
		state.service.upgradeMcpV3('workspace-1', command({ generationId: 'generation-2' })),
		(error: unknown) => error instanceof McpProtocolV3Error && error.code === 'GENERATION_AFFINITY_MISMATCH',
	);
	assert.equal(state.agentCalls.length, 0, 'a refused generation mismatch must not touch a replica');
});

test('a command carrying a different authorization epoch is refused', async () => {
	const state = fixture();
	await assert.rejects(
		state.service.upgradeMcpV3('workspace-1', command({ authorizationEpoch: 8 })),
		(error: unknown) => error instanceof McpProtocolV3Error && error.code === 'GENERATION_AFFINITY_MISMATCH',
	);
	assert.equal(state.agentCalls.length, 0);
});

test('an unknown runtime installation is refused as not upgradable', async () => {
	const state = fixture();
	await assert.rejects(
		state.service.upgradeMcpV3('workspace-1', command({ runtimeInstallationId: 'runtime-unknown' })),
		(error: unknown) => error instanceof McpProtocolV3Error && error.code === 'RUNTIME_NOT_UPGRADABLE',
	);
	assert.equal(state.agentCalls.length, 0);
});

test('a revision below the applied one is refused as a downgrade — the old runtime is untouched', async () => {
	const state = fixture(runningApp({ mcpAppliedRevision: 3, mcpAppliedUpgradeEpoch: 3 }));
	await assert.rejects(
		state.service.upgradeMcpV3('workspace-1', command({ revision: 2, upgradeEpoch: 2 })),
		(error: unknown) => error instanceof McpProtocolV3Error && error.code === 'UPGRADE_EPOCH_INVALID' && error.message === 'revision_downgrade',
	);
	assert.equal(state.agentCalls.length, 0);
});

test('replaying the applied revision with a different target is refused as a reused epoch, before any container is touched', async () => {
	const state = fixture();
	await state.service.upgradeMcpV3('workspace-1', command());
	await assert.rejects(
		state.service.upgradeMcpV3('workspace-1', command({
			jti: '44444444-4444-4444-8444-444444444444',
			targetManifestDigest: `sha256:${'a'.repeat(64)}`,
			targetImageDigest: `sha256:${'a'.repeat(64)}`,
		})),
		(error: unknown) => error instanceof McpProtocolV3Error && error.message === 'epoch_reused',
	);
	assert.equal(state.agentCalls.length, 1, 'the refused replay must not touch a replica a second time');
	assert.equal(state.apps[0]!.manifestDigest, `sha256:${'f'.repeat(64)}`, 'the already-applied upgrade must not be undone');
});

test('replaying the applied revision with the identical target is an idempotent no-op', async () => {
	const state = fixture();
	await state.service.upgradeMcpV3('workspace-1', command());
	const repeat = await state.service.upgradeMcpV3('workspace-1', command({
		jti: '55555555-5555-4555-8555-555555555555',
	}));
	assert.equal(repeat.app.mcpAppliedRevision, 1);
	assert.equal(repeat.swapStrategy, 'STOP_THEN_CREATE');
	assert.equal(state.agentCalls.length, 1, 'an idempotent repeat must not redeploy the container again');
});

test('a command whose previous digest disagrees with what is actually running is refused', async () => {
	const state = fixture();
	await assert.rejects(
		state.service.upgradeMcpV3('workspace-1', command({ previousImageDigest: `sha256:${'0'.repeat(64)}` })),
		(error: unknown) => error instanceof McpProtocolV3Error && error.code === 'UPGRADE_PREVIOUS_DIGEST_MISMATCH',
	);
	assert.equal(state.agentCalls.length, 0);
});

test('a runtime that is not RUNNING is not upgradable', async () => {
	const state = fixture(runningApp({ state: 'QUARANTINED' }));
	await assert.rejects(
		state.service.upgradeMcpV3('workspace-1', command()),
		(error: unknown) => error instanceof McpProtocolV3Error && error.code === 'RUNTIME_NOT_UPGRADABLE',
	);
});

test('a swap failure propagates and leaves the old runtime serving — the app record is never half-upgraded', async () => {
	const state = fixture(runningApp(), () => ({ status: 500, body: { error: 'agent_unreachable' } }));
	await assert.rejects(
		state.service.upgradeMcpV3('workspace-1', command()),
		(error: unknown) => error instanceof Error && (error as any).code === 'MCP_V3_UPGRADE_SWAP_FAILED',
	);
	assert.equal(state.apps[0]!.manifestDigest, `sha256:${'e'.repeat(64)}`, 'the old digest must still be the persisted one');
	assert.equal(state.apps[0]!.mcpAppliedRevision ?? 0, 0, 'no revision was ever applied');
});

test('a swap failure reports rolledBack only when the agent confirms it recovered the previous image', async () => {
	const state = fixture(runningApp(), () => ({ status: 500, body: { error: 'boom', recovered: true } }));
	await assert.rejects(
		state.service.upgradeMcpV3('workspace-1', command()),
		(error: unknown) => (error as any).rolledBack === true,
	);

	const unconfirmed = fixture(runningApp(), () => ({ status: 500, body: { error: 'boom' } }));
	await assert.rejects(
		unconfirmed.service.upgradeMcpV3('workspace-1', command()),
		(error: unknown) => (error as any).rolledBack === false,
	);
});

test('an HA generation upgrades one replica at a time; a second-replica failure reverts the first back to the previous digest', async () => {
	const state = fixture(runningApp({
		availabilityTier: 'ha',
		replicas: [
			{ replicaId: 'replica-1', nodeId: 'node-1', containerId: 'container-1', state: 'running' },
			{ replicaId: 'replica-2', nodeId: 'node-2', containerId: 'container-2', state: 'running' },
		],
	}), (path) => {
		if (path === '/api/v1/apps/container-2/redeploy') return { status: 500, body: { error: 'boom' } };
		return { status: 200, body: { swapStrategy: 'STOP_THEN_CREATE' } };
	});

	await assert.rejects(state.service.upgradeMcpV3('workspace-1', command()));

	assert.deepEqual(
		state.agentCalls.map((call) => call.path),
		[
			'/api/v1/apps/container-1/redeploy', // forward, succeeds
			'/api/v1/apps/container-2/redeploy', // forward, fails
			'/api/v1/apps/container-1/redeploy', // revert, back to previous
		],
	);
	const revertCall = state.agentCalls[2]!;
	assert.equal(revertCall.body.digest, `sha256:${'e'.repeat(64)}`);
	assert.equal(revertCall.body.mcpV3Binding.imageDigest, `sha256:${'e'.repeat(64)}`);
	assert.equal(state.apps[0]!.manifestDigest, `sha256:${'e'.repeat(64)}`, 'nothing was persisted as upgraded');
});


test('the redeploy body carries the image repository, never the digest currently running', async () => {
	// `app.image` is pinned to the digest currently SERVING; a swap names a
	// different one in both directions. Sending the row verbatim makes the agent
	// refuse its own disagreeing pin, failing the upgrade before anything is
	// touched. The fixture was already pinned the way production is — what was
	// missing was anyone asserting what actually got sent.
	const state = fixture();
	await state.service.upgradeMcpV3('workspace-1', command());

	const [call] = state.agentCalls;
	assert.equal(call!.body.image, 'registry.example/app');
	assert.ok(!String(call!.body.image).includes('@'), 'the redeploy image must carry no digest pin');
	// The digest still travels separately, so the agent composes repository@digest.
	assert.equal(call!.body.digest, `sha256:${'f'.repeat(64)}`);
});
