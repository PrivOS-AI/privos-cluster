import assert from 'node:assert/strict';
import test from 'node:test';

import { McpUninstallServiceV3 } from './mcp-uninstall-service-v3.js';
import { ResourceCleanupResultV3Schema } from './protocol-v3.js';
import type { RuntimeResourceDescriptorV3 } from './protocol-v3.js';

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
			updateOne: async ({ checkpointKey }: { checkpointKey: string }, update: any) => {
				if (!world.checkpoints.has(checkpointKey)) world.checkpoints.set(checkpointKey, update.$setOnInsert);
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
				world.signedState = input.state;
				world.signedResults = input.results;
				return { payload: { jti: 'ack-1' }, compact: 'signed.ack', artifactHash: 'H'.repeat(43), kid: 'K'.repeat(43) };
			},
		} as any,
		clusterId: 'cluster-1',
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
