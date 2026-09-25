import assert from 'node:assert/strict';
import test from 'node:test';

import { McpUninstallServiceV3 } from './mcp-uninstall-service-v3.js';
import { ResourceCleanupResultV3Schema } from '../protocol/protocol-v3.js';
import type { RuntimeResourceDescriptorV3 } from '../protocol/protocol-v3.js';

const expectedResources: RuntimeResourceDescriptorV3[] = [
	{ kind: 'CONTAINER', resourceId: 'container:replica-1', ownershipScope: 'INSTALLATION_GENERATION', nodeId: 'node-1', replicaId: '2f5b7bd6-1f7d-4a2e-9a1e-2a5a0f7f0d11', attributes: { containerId: 'container-1' } },
	{ kind: 'VOLUME', resourceId: 'volume:data', ownershipScope: 'INSTALLATION_GENERATION', nodeId: 'node-1', replicaId: null, attributes: { volumeName: 'privos-app-1-data' } },
	{ kind: 'INGRESS', resourceId: 'ingress:app-1', ownershipScope: 'INSTALLATION_GENERATION', nodeId: null, replicaId: null, attributes: { subdomain: 'app-1' } },
];

const command = {
	protocolVersion: 3,
	type: 'cluster-lifecycle-command',
	iss: 'urn:privos:hub:deployment-1',
	aud: 'privos-apps-master',
	jti: '5d0d5c98-6d3e-4b3f-9e0f-1c2b3a4d5e6f',
	nonce: 'nonce-1',
	iat: 1_785_800_000,
	exp: 1_785_800_300,
	action: 'UNINSTALL_RUNTIME',
	operationId: '9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d',
	clusterId: 'cluster-1',
	workspaceId: 'workspace-1',
	deploymentId: 'deployment-1',
	generationId: 'generation-1',
	generationNumber: 1,
	runtimeInstallationId: 'installation-1',
	clusterAppId: 'cluster-app-1',
	manifestDigest: `sha256:${'a'.repeat(64)}`,
	resourceManifestHash: 'B'.repeat(43),
	runtimeResourceInventoryHash: 'C'.repeat(43),
	reasonCode: 'workspace_uninstall',
	expectedResourceCount: 3,
} as any;

type World = {
	nodeOutcomes: Record<string, Array<{ kind: string; resourceId: string; status: string; reasonCode: string | null }>>;
	nodeAvailable: boolean;
	ingressFails: boolean;
	appUpdates: Array<{ $set?: Record<string, unknown>; $unset?: Record<string, unknown> }>;
	operations: Map<string, any>;
	checkpoints: Map<string, any>;
	cleanupResults: Map<string, any>;
	signedState?: string;
	signedResults?: unknown[];
	signerFailuresRemaining?: number;
	removeAllAppHostsCalls?: Array<{ appId: string; generationId?: string }>;
	markDirtyCalls?: number;
};

function buildService(world: World) {
	const repositories = {
		runtimeResourceInventories: {
			findOne: async () => ({ inventoryId: 'inventory-1', expectedResources }),
		},
		clusterLifecycleOperations: {
			findOne: async ({ operationId }: { operationId: string }) => world.operations.get(operationId) ?? null,
			insertOne: async (record: any) => {
				if (world.operations.has(record.operationId)) throw Object.assign(new Error('dup'), { code: 11000 });
				world.operations.set(record.operationId, { ...record });
			},
			updateOne: async ({ operationId }: { operationId: string }, update: any) => {
				const current = world.operations.get(operationId) ?? {};
				const next = { ...current, ...(update.$set ?? {}) };
				for (const [key, amount] of Object.entries<number>(update.$inc ?? {})) next[key] = (next[key] ?? 0) + amount;
				world.operations.set(operationId, next);
			},
		},
		clusterLifecycleCheckpoints: {
			// Mirrors the real collection's unique index: one document per
			// (operationId, sequence), with the latest attempt's content applied.
			updateOne: async (filter: { operationId: string; sequence: number }, update: any) => {
				const key = `${filter.operationId}:${filter.sequence}`;
				const current = world.checkpoints.get(key) ?? { ...(update.$setOnInsert ?? {}) };
				world.checkpoints.set(key, { ...current, ...(update.$set ?? {}) });
			},
		},
		clusterCleanupResults: {
			updateOne: async (filter: any, update: any) => {
				world.cleanupResults.set(`${filter.resourceClass} ${filter.resourceId}`, update.$set);
			},
		},
		apps: {
			updateOne: async (_filter: unknown, update: any) => {
				world.appUpdates.push(update);
			},
		},
		nodes: {
			find: () => ({ toArray: async () => (world.nodeAvailable ? [{ nodeId: 'node-1', url: 'http://node', keyId: 'k', encryptedFleetKey: 'e' }] : []) }),
		},
	};
	return new McpUninstallServiceV3({
		repositories: repositories as any,
		agentClient: {
			request: async (_node: unknown, _workspaceId: string, _method: string, path: string) => ({
				status: 200,
				headers: {},
				body: { results: world.nodeOutcomes[path.endsWith('/remove') ? 'remove' : 'absence'] },
			}),
		} as any,
		ingress: {
			remove: async () => {
				if (world.ingressFails) throw new Error('cloudflare unavailable');
			},
		} as any,
		clusterMasterIdentity: {
			publicInfo: async () => ({ kid: 'K'.repeat(43) }),
			signFinalAcknowledgement: async (input: any) => {
				if ((world.signerFailuresRemaining ?? 0) > 0) {
					world.signerFailuresRemaining! -= 1;
					throw new Error('acknowledgement signing failed');
				}
				world.signedState = input.state;
				world.signedResults = input.results;
				return { payload: { jti: 'ack-1' }, compact: 'signed.ack', artifactHash: 'H'.repeat(43), kid: 'K'.repeat(43) };
			},
		} as any,
		clusterId: 'cluster-1',
		appHosts: world.removeAllAppHostsCalls ? {
			removeAllAppHosts: async (appId: string, generationId?: string) => {
				world.removeAllAppHostsCalls!.push({ appId, generationId });
				return 0;
			},
		} as any : undefined,
		hostTablePublisher: world.markDirtyCalls !== undefined ? {
			markDirty: () => { world.markDirtyCalls = (world.markDirtyCalls ?? 0) + 1; },
		} as any : undefined,
	});
}

function freshWorld(overrides: Partial<World> = {}): World {
	const removed = [
		{ kind: 'CONTAINER', resourceId: 'container:replica-1', status: 'REMOVED', reasonCode: null },
		{ kind: 'VOLUME', resourceId: 'volume:data', status: 'REMOVED', reasonCode: null },
	];
	const absent = [
		{ kind: 'CONTAINER', resourceId: 'container:replica-1', status: 'ABSENT', reasonCode: null },
		{ kind: 'VOLUME', resourceId: 'volume:data', status: 'ABSENT', reasonCode: null },
	];
	return {
		nodeOutcomes: { remove: removed, absence: absent },
		nodeAvailable: true,
		ingressFails: false,
		appUpdates: [],
		operations: new Map(),
		checkpoints: new Map(),
		cleanupResults: new Map(),
		...overrides,
	};
}

test('removes every declared resource and only then signs a completed acknowledgement', async () => {
	const world = freshWorld();
	const result = await buildService(world).uninstall({ workspaceId: 'workspace-1', command, commandHash: 'D'.repeat(43) });
	assert.equal(result.state, 'COMPLETED');
	assert.equal(world.signedState, 'COMPLETED');
	assert.equal(world.cleanupResults.size, 3);
	// Dispatch is refused before anything is deleted, and only a proven-clean
	// cascade marks the app removed.
	assert.equal(world.appUpdates[0].$set?.state, 'REVOKING');
	assert.equal(world.appUpdates.at(-1)?.$set?.state, 'REMOVED');
	assert.ok(world.checkpoints.size >= 5);
});

test('E: a COMPLETED uninstall runs its own removeAllAppHosts teardown step, scoped to this generation', async () => {
	const world = freshWorld({ removeAllAppHostsCalls: [], markDirtyCalls: 0 });
	const result = await buildService(world).uninstall({ workspaceId: 'workspace-1', command, commandHash: 'D'.repeat(43) });
	assert.equal(result.state, 'COMPLETED');
	assert.deepEqual(world.removeAllAppHostsCalls, [{ appId: 'cluster-app-1', generationId: 'generation-1' }]);
	assert.equal(world.markDirtyCalls, 1);
});

test('a volume the node cannot prove absent blocks completion instead of passing', async () => {
	const world = freshWorld({
		nodeOutcomes: {
			remove: [
				{ kind: 'CONTAINER', resourceId: 'container:replica-1', status: 'REMOVED', reasonCode: null },
				{ kind: 'VOLUME', resourceId: 'volume:data', status: 'FAILED', reasonCode: 'volume_busy' },
			],
			absence: [
				{ kind: 'CONTAINER', resourceId: 'container:replica-1', status: 'ABSENT', reasonCode: null },
				{ kind: 'VOLUME', resourceId: 'volume:data', status: 'FAILED', reasonCode: 'volume_still_present' },
			],
		},
	});
	const result = await buildService(world).uninstall({ workspaceId: 'workspace-1', command, commandHash: 'D'.repeat(43) });
	assert.equal(result.state, 'CLEANUP_REQUIRED');
	assert.equal(world.signedState, 'CLEANUP_REQUIRED');
	// Access stays revoked; the app is never marked removed on residue.
	assert.equal(world.appUpdates[0].$set?.state, 'REVOKING');
	assert.ok(!world.appUpdates.some((update) => update.$set?.state === 'REMOVED'));
});

test('every reported reason stays signable, whatever a node calls it', async () => {
	// A residue result is the only path that carries a reason, and the reason
	// travels inside the signed acknowledgement. A code the payload schema
	// rejects fails the signature and leaves the uninstall unfinishable, so the
	// node is not trusted to name its own failures in the wire alphabet.
	const world = freshWorld({
		nodeOutcomes: {
			remove: [
				{ kind: 'CONTAINER', resourceId: 'container:replica-1', status: 'REMOVED', reasonCode: null },
				{ kind: 'VOLUME', resourceId: 'volume:data', status: 'FAILED', reasonCode: 'volume busy: /var/lib/x' },
			],
			absence: [
				{ kind: 'CONTAINER', resourceId: 'container:replica-1', status: 'ABSENT', reasonCode: null },
				{ kind: 'VOLUME', resourceId: 'volume:data', status: 'FAILED', reasonCode: 'volume_still_present' },
			],
		},
	});
	const result = await buildService(world).uninstall({ workspaceId: 'workspace-1', command, commandHash: 'D'.repeat(43) });
	assert.equal(result.state, 'CLEANUP_REQUIRED');
	for (const signed of world.signedResults ?? []) {
		ResourceCleanupResultV3Schema.parse(signed);
	}
	const volume = (world.signedResults ?? []).find(
		(entry) => (entry as { resourceId?: string }).resourceId === 'volume:data',
	) as { reasonCode?: string } | undefined;
	assert.equal(volume?.reasonCode, 'VOLUME_STILL_PRESENT');
});

test('an unreachable node is unknown, never a silent success', async () => {
	const world = freshWorld({ nodeAvailable: false });
	const result = await buildService(world).uninstall({ workspaceId: 'workspace-1', command, commandHash: 'D'.repeat(43) });
	assert.equal(result.state, 'CLEANUP_REQUIRED');
	const unknown = (world.signedResults as Array<{ status: string; verifiedAt: string | null }>).filter(
		(entry) => entry.status === 'UNKNOWN',
	);
	assert.equal(unknown.length, 2);
	assert.ok(unknown.every((entry) => entry.verifiedAt === null));
});

test('a failed ingress removal is reported rather than assumed', async () => {
	const world = freshWorld({ ingressFails: true });
	const result = await buildService(world).uninstall({ workspaceId: 'workspace-1', command, commandHash: 'D'.repeat(43) });
	assert.equal(result.state, 'COMPLETED');
	// The removal attempt failed, but the independent absence pass is what
	// decides completion, so the failure is recorded without inventing success.
	assert.equal(world.cleanupResults.get('INGRESS ingress:app-1').result.status, 'ABSENT');
});

test('redelivering the same command replays the stored acknowledgement', async () => {
	const world = freshWorld();
	const service = buildService(world);
	const first = await service.uninstall({ workspaceId: 'workspace-1', command, commandHash: 'D'.repeat(43) });
	const second = await service.uninstall({ workspaceId: 'workspace-1', command, commandHash: 'D'.repeat(43) });
	assert.equal(second.state, 'COMPLETED');
	assert.equal(second.acknowledgement.compact, first.acknowledgement.compact);
	assert.equal(world.operations.size, 1);
});

test('a retry under a freshly minted command resumes the same operation', async () => {
	// Commands are short lived and the Hub mints a new one per attempt, so a
	// different artifact is the normal shape of a retry, not a conflict.
	const world = freshWorld();
	const service = buildService(world);
	const first = await service.uninstall({ workspaceId: 'workspace-1', command, commandHash: 'D'.repeat(43) });
	const retried = await service.uninstall({
		workspaceId: 'workspace-1',
		command: { ...command, jti: 'a1b2c3d4-0000-4000-8000-000000000001', nonce: 'nonce-2' },
		commandHash: 'E'.repeat(43),
	});
	assert.equal(retried.operationId, first.operationId);
	assert.equal(world.operations.size, 1);
});

test('an attempt that dies mid-flight is parked and the next one resumes to completion', async () => {
	// The exact production wreckage: the signer throws after the VERIFYING
	// checkpoint, so without parking the operation is stuck in a state no new
	// attempt may legally leave.
	const world = freshWorld({ signerFailuresRemaining: 1 });
	const service = buildService(world);
	await assert.rejects(
		() => service.uninstall({ workspaceId: 'workspace-1', command, commandHash: 'D'.repeat(43) }),
		/acknowledgement signing failed/,
	);
	const parked = world.operations.get(command.operationId);
	assert.equal(parked.state, 'CLEANUP_REQUIRED');
	assert.equal(parked.attempts, 1);

	const retried = await service.uninstall({
		workspaceId: 'workspace-1',
		command: { ...command, jti: 'a1b2c3d4-0000-4000-8000-000000000002', nonce: 'nonce-3' },
		commandHash: 'F'.repeat(43),
	});
	assert.equal(retried.state, 'COMPLETED');
	assert.equal(world.operations.get(command.operationId).attempts, 2);
});

test('a hard crash that never parked is recovered on the next entry', async () => {
	// kill -9 shape: no catch ran, so the stored state is a mid-attempt one.
	const world = freshWorld({ signerFailuresRemaining: 1 });
	const service = buildService(world);
	await assert.rejects(() => service.uninstall({ workspaceId: 'workspace-1', command, commandHash: 'D'.repeat(43) }));
	world.operations.get(command.operationId).state = 'VERIFYING';

	const retried = await service.uninstall({
		workspaceId: 'workspace-1',
		command: { ...command, jti: 'a1b2c3d4-0000-4000-8000-000000000003', nonce: 'nonce-4' },
		commandHash: 'A'.repeat(43),
	});
	assert.equal(retried.state, 'COMPLETED');
});

test('a residue attempt followed by a clean one converges to COMPLETED', async () => {
	// The production shape: attempt one signs CLEANUP_REQUIRED and writes the
	// final checkpoint; the world is then actually cleaned; attempt two proves
	// it and must be able to re-write that sequence with the better outcome
	// instead of colliding with the unique (operationId, sequence) index.
	const world = freshWorld({
		nodeOutcomes: {
			remove: [
				{ kind: 'CONTAINER', resourceId: 'container:replica-1', status: 'REMOVED', reasonCode: null },
				{ kind: 'VOLUME', resourceId: 'volume:data', status: 'FAILED', reasonCode: 'volume_busy' },
			],
			absence: [
				{ kind: 'CONTAINER', resourceId: 'container:replica-1', status: 'ABSENT', reasonCode: null },
				{ kind: 'VOLUME', resourceId: 'volume:data', status: 'FAILED', reasonCode: 'volume_still_present' },
			],
		},
	});
	const service = buildService(world);
	const first = await service.uninstall({ workspaceId: 'workspace-1', command, commandHash: 'D'.repeat(43) });
	assert.equal(first.state, 'CLEANUP_REQUIRED');

	world.nodeOutcomes = {
		remove: [
			{ kind: 'CONTAINER', resourceId: 'container:replica-1', status: 'ABSENT', reasonCode: null },
			{ kind: 'VOLUME', resourceId: 'volume:data', status: 'ABSENT', reasonCode: null },
		],
		absence: [
			{ kind: 'CONTAINER', resourceId: 'container:replica-1', status: 'ABSENT', reasonCode: null },
			{ kind: 'VOLUME', resourceId: 'volume:data', status: 'ABSENT', reasonCode: null },
		],
	};
	const second = await service.uninstall({
		workspaceId: 'workspace-1',
		command: { ...command, jti: 'a1b2c3d4-0000-4000-8000-000000000004', nonce: 'nonce-5' },
		commandHash: 'B'.repeat(43),
	});
	assert.equal(second.state, 'COMPLETED');
	const finalCheckpoint = world.checkpoints.get(`${command.operationId}:5`);
	assert.equal(finalCheckpoint.checkpoint.state, 'COMPLETED');
	assert.ok(world.appUpdates.some((update) => update.$set?.state === 'REMOVED'));
});

test('a command naming a different runtime is a replay conflict', async () => {
	const world = freshWorld();
	const service = buildService(world);
	await service.uninstall({ workspaceId: 'workspace-1', command, commandHash: 'D'.repeat(43) });
	await assert.rejects(
		() => service.uninstall({
			workspaceId: 'workspace-1',
			command: { ...command, runtimeInstallationId: 'c3f0a1d2-0000-4000-8000-00000000dead' },
			commandHash: 'E'.repeat(43),
		}),
		/lifecycle command affinity conflict/,
	);
});
