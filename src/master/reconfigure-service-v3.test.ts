/**
 * Configuration redeploy: the epoch guard, the environment that actually
 * reaches the agent, and the secret handling at rest.
 *
 * The threat this closes is an operator-visible one: a config change must never
 * become a way to move the generation, widen permissions, replay an older
 * environment, or leave a rotated secret readable in the master database.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DeploymentService } from './deployment-service.js';
import { KeyCipher } from './key-crypto.js';
import { QuotaError } from './quota-service.js';
import { SchedulingError } from './scheduler.js';
import { McpProtocolV3Error, type ClusterReconfigureCommandPayloadV3 } from '../protocol/protocol-v3.js';
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
		manifestDigest: `sha256:${'f'.repeat(64)}`,
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

function command(overrides: Partial<ClusterReconfigureCommandPayloadV3> = {}): ClusterReconfigureCommandPayloadV3 {
	const now = Math.floor(Date.now() / 1000);
	return {
		protocolVersion: 3,
		type: 'cluster-reconfigure-command',
		iss: 'urn:privos:hub:deployment-1',
		aud: 'privos-apps-master',
		jti: '22222222-2222-4222-8222-222222222222',
		nonce: 'reconfigure-nonce-12345678',
		iat: now,
		exp: now + 300,
		action: 'RECONFIGURE_RUNTIME',
		operationId: '33333333-3333-4333-8333-333333333333',
		clusterId: 'cluster-1',
		workspaceId: 'workspace-1',
		deploymentId: 'deployment-1',
		generationId: 'generation-1',
		generationNumber: 1,
		runtimeInstallationId: 'runtime-1',
		clusterAppId: 'cluster-app-1',
		mcpAppId: 'mcp-app-1',
		manifestDigest: `sha256:${'f'.repeat(64)}`,
		resourceManifestHash: 'r'.repeat(43),
		runtimeResourceInventoryHash: 'i'.repeat(43),
		authorizationEpoch: 7,
		configEpoch: 2,
		envVars: { HRM_COMPANY_NAME: 'Acme GmbH', HRM_SMTP_PASSWORD: 'canary-secret-value' },
		secretKeys: ['HRM_SMTP_PASSWORD'],
		...overrides,
	};
}

function fixture(app: MasterApp = runningApp(), extra: {
	nodes?: MasterNode[];
	otherApps?: MasterApp[];
	quota?: { assertResizeAllowed?: (...args: any[]) => Promise<void> };
	failContainerIds?: string[];
} = {}) {
	const apps = [structuredClone(app)];
	const otherApps = (extra.otherApps ?? []).map((candidate) => structuredClone(candidate));
	const nodes: MasterNode[] = extra.nodes ?? [{
		nodeId: 'node-1', url: 'https://node-1.internal', region: 'eu', failureDomain: 'fd-1',
		capacity: { memoryMb: 4096, cpus: 4, diskBytes: 10_000_000_000 }, status: 'ACTIVE',
		keyId: 'key-1', encryptedFleetKey: 'encrypted-1', createdAt: new Date(), updatedAt: new Date(),
	}];
	const agentCalls: Array<{ path: string; body: any }> = [];
	const lifecycleEvents: Array<{ eventId: string; workspaceId: string; appId: string; type: string; resources: unknown; at: Date }> = [];
	const service = new DeploymentService({
		repositories: {
			apps: {
				findOne: async () => structuredClone(apps[0] ?? null),
				find: (filter: { state?: string }) => ({
					toArray: async () => structuredClone([...apps, ...otherApps].filter((candidate) => !filter.state || candidate.state === filter.state)),
				}),
				updateOne: async (filter: any, update: any) => {
					const applied = apps[0]!.appliedConfigEpoch ?? 1;
					if (filter.appliedConfigEpoch?.$lt !== undefined && !(applied < filter.appliedConfigEpoch.$lt)) {
						return { matchedCount: 0 };
					}
					Object.assign(apps[0]!, structuredClone(update.$set ?? {}));
					for (const key of Object.keys(update.$unset ?? {})) delete (apps[0] as any)[key];
					return { matchedCount: 1 };
				},
			},
			nodes: { find: () => ({ toArray: async () => structuredClone(nodes) }) },
			lifecycleEvents: {
				insertOne: async (event: any) => { lifecycleEvents.push(structuredClone(event)); },
			},
		} as any,
		agentClient: {
			request: async (_node: MasterNode, _ws: string, _method: string, path: string, body: any) => {
				agentCalls.push({ path, body });
				const containerId = path.split('/').at(-2);
				if (extra.failContainerIds?.includes(containerId!)) {
					return { status: 503, body: { error: 'injected_failure' } };
				}
				return { status: 200, body: { ok: true } };
			},
		} as any,
		ingress: {} as any,
		quota: (extra.quota ?? { assertResizeAllowed: async () => undefined }) as any,
		subdomains: {} as any,
		locks: { run: async (_ws: string, work: () => Promise<unknown>) => work() } as any,
		baseDomain: 'apps.example.com',
		cipher: new KeyCipher(CIPHER_KEY),
	});
	return { apps, agentCalls, lifecycleEvents, service };
}

test('a verified epoch reaches every replica with the platform env injected', async () => {
	const state = fixture();
	const result = await state.service.reconfigureMcpV3('workspace-1', command());

	assert.equal(state.agentCalls.length, 1);
	const [call] = state.agentCalls;
	assert.equal(call!.path, '/api/v1/mcp/v3/apps/container-1/reconfigure');
	assert.deepEqual(call!.body.envVars, {
		HRM_COMPANY_NAME: 'Acme GmbH',
		HRM_SMTP_PASSWORD: 'canary-secret-value',
	});
	// M5: MCP_EMIT_APP_PUBLIC_URL defaults off (this fixture never sets
	// `emitAppPublicUrl`) — byte-identical to pre-rename behaviour, only the
	// legacy key, never the renamed PRIVOS_APP_PUBLIC_URL. See
	// `deployment-service-null-safe.test.ts` for the emit-on matrix.
	assert.deepEqual(call!.body.platformEnvVars, {
		PRIVOS_PUBLIC_URL: 'https://library-app.apps.example.com',
		PRIVOS_ACCESS_MODE: 'managed-runtime',
	});
	assert.deepEqual(call!.body.secretEnvKeys, ['HRM_SMTP_PASSWORD']);
	// Hub identity is never restated by a reconfigure: the agent reuses the key
	// the generation was provisioned under, from its own container labels.
	assert.equal(call!.body.mcpV3Binding.hubKid, undefined);
	assert.equal(call!.body.mcpV3Binding.hubPublicJwk, undefined);
	assert.equal(result.app.appliedConfigEpoch, 2);
	assert.deepEqual(result.appliedKeys, ['HRM_COMPANY_NAME', 'HRM_SMTP_PASSWORD']);
});

test('a secret value is sealed at rest, never left queryable on the app row', async () => {
	const state = fixture();
	await state.service.reconfigureMcpV3('workspace-1', command());

	const stored = state.apps[0]!;
	assert.deepEqual(stored.envVars, { HRM_COMPANY_NAME: 'Acme GmbH' });
	assert.deepEqual(stored.secretEnvKeys, ['HRM_SMTP_PASSWORD']);
	assert.ok(stored.secretEnvVarsEnc, 'the secret half must be sealed');
	assert.ok(
		!JSON.stringify({ ...stored, secretEnvVarsEnc: '' }).includes('canary-secret-value'),
		'no queryable field may carry the secret value',
	);
	assert.equal(
		JSON.parse(new KeyCipher(CIPHER_KEY).decrypt(stored.secretEnvVarsEnc!)).HRM_SMTP_PASSWORD,
		'canary-secret-value',
	);
});

test('dropping the last secret clears the sealed blob rather than stranding it', async () => {
	const state = fixture();
	await state.service.reconfigureMcpV3('workspace-1', command());
	await state.service.reconfigureMcpV3('workspace-1', command({
		jti: '44444444-4444-4444-8444-444444444444',
		configEpoch: 3,
		envVars: { HRM_COMPANY_NAME: 'Acme GmbH' },
		secretKeys: [],
	}));

	const stored = state.apps[0]!;
	assert.equal(stored.secretEnvVarsEnc, undefined);
	assert.deepEqual(stored.secretEnvKeys, []);
	assert.equal(stored.appliedConfigEpoch, 3);
});

test('an epoch below the applied one is refused as a downgrade', async () => {
	const state = fixture(runningApp({ appliedConfigEpoch: 5 }));
	await assert.rejects(
		state.service.reconfigureMcpV3('workspace-1', command({ configEpoch: 4 })),
		(error: unknown) =>
			error instanceof McpProtocolV3Error &&
			error.code === 'CONFIG_EPOCH_INVALID' &&
			error.message === 'epoch_downgrade',
	);
	assert.equal(state.agentCalls.length, 0);
});

test('replaying the applied epoch with a different environment is refused', async () => {
	const state = fixture();
	await state.service.reconfigureMcpV3('workspace-1', command());
	await assert.rejects(
		state.service.reconfigureMcpV3('workspace-1', command({
			jti: '55555555-5555-4555-8555-555555555555',
			envVars: { HRM_COMPANY_NAME: 'Attacker Ltd', HRM_SMTP_PASSWORD: 'canary-secret-value' },
		})),
		(error: unknown) => error instanceof McpProtocolV3Error && error.message === 'epoch_reused',
	);
	assert.equal(state.agentCalls.length, 1, 'the refused replay must not touch a replica');
});

test('replaying the applied epoch with the identical environment is idempotent', async () => {
	const state = fixture();
	await state.service.reconfigureMcpV3('workspace-1', command());
	const repeat = await state.service.reconfigureMcpV3('workspace-1', command());
	assert.equal(repeat.app.appliedConfigEpoch, 2);
	assert.equal(state.agentCalls.length, 1, 'an idempotent repeat must not restart the container again');
});

test('a command naming another generation cannot reach this runtime', async () => {
	const state = fixture();
	await assert.rejects(
		state.service.reconfigureMcpV3('workspace-1', command({ generationId: 'generation-2' })),
		(error: unknown) => error instanceof McpProtocolV3Error && error.code === 'GENERATION_AFFINITY_MISMATCH',
	);
	assert.equal(state.agentCalls.length, 0);
});

test('a command carrying a different authorization epoch cannot widen the runtime', async () => {
	const state = fixture();
	await assert.rejects(
		state.service.reconfigureMcpV3('workspace-1', command({ authorizationEpoch: 8 })),
		(error: unknown) => error instanceof McpProtocolV3Error && error.code === 'GENERATION_AFFINITY_MISMATCH',
	);
});

test('a runtime that is not running is not reconfigurable', async () => {
	const state = fixture(runningApp({ state: 'QUARANTINED' }));
	await assert.rejects(
		state.service.reconfigureMcpV3('workspace-1', command()),
		(error: unknown) => error instanceof McpProtocolV3Error && error.code === 'RUNTIME_NOT_RECONFIGURABLE',
	);
});

test('an HA generation reconfigures its replicas one at a time', async () => {
	const state = fixture(runningApp({
		availabilityTier: 'ha',
		replicas: [
			{ replicaId: 'replica-1', nodeId: 'node-1', containerId: 'container-1', state: 'running' },
			{ replicaId: 'replica-2', nodeId: 'node-1', containerId: 'container-2', state: 'running' },
		],
	}));
	await state.service.reconfigureMcpV3('workspace-1', command());
	assert.deepEqual(
		state.agentCalls.map((call) => call.path),
		['/api/v1/mcp/v3/apps/container-1/reconfigure', '/api/v1/mcp/v3/apps/container-2/reconfigure'],
	);
});

// ---------------------------------------------------------------------------
// resize (command.resources)
// ---------------------------------------------------------------------------

test('resources on the command resizes the replica in place, persists app.resources, and emits RESIZED', async () => {
	const state = fixture();
	const result = await state.service.reconfigureMcpV3('workspace-1', command({
		resources: { memoryMb: 512, cpus: 1, tmpSizeMb: 64 },
	}));
	assert.equal(state.agentCalls.length, 1);
	assert.deepEqual(state.agentCalls[0]!.body.resources, { memoryMb: 512, cpus: 1, tmpSizeMb: 64 });
	assert.deepEqual(result.app.resources, { memoryMb: 512, cpus: 1, tmpSizeMb: 64 });
	assert.deepEqual(state.apps[0]!.resources, { memoryMb: 512, cpus: 1, tmpSizeMb: 64 });
	assert.equal(state.lifecycleEvents.length, 1);
	assert.equal(state.lifecycleEvents[0]!.type, 'RESIZED');
	assert.equal(state.lifecycleEvents[0]!.appId, 'cluster-app-1');
	assert.deepEqual(state.lifecycleEvents[0]!.resources, { memoryMb: 512, cpus: 1, tmpSizeMb: 64 });
});

test('absent resources leaves app.resources untouched and never emits RESIZED — byte-identical to before this field existed', async () => {
	const state = fixture();
	await state.service.reconfigureMcpV3('workspace-1', command());
	assert.deepEqual(state.apps[0]!.resources, { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 });
	assert.equal(state.lifecycleEvents.length, 0);
});

test('a resize refused by the workspace quota delta touches no replica and leaves resources unchanged', async () => {
	const state = fixture(runningApp(), {
		quota: {
			assertResizeAllowed: async () => {
				throw new QuotaError('MEMORY_QUOTA_EXCEEDED', 'workspace reserved memory quota exceeded');
			},
		},
	});
	await assert.rejects(
		state.service.reconfigureMcpV3('workspace-1', command({ resources: { memoryMb: 4096, cpus: 4, tmpSizeMb: 64 } })),
		(error: unknown) => error instanceof QuotaError && error.code === 'MEMORY_QUOTA_EXCEEDED',
	);
	assert.equal(state.agentCalls.length, 0);
	assert.deepEqual(state.apps[0]!.resources, { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 });
});

test('a resize refused for lack of room on the replica\'s current node touches no replica — there is no migration', async () => {
	const state = fixture(runningApp(), {
		nodes: [{
			nodeId: 'node-1', url: 'https://node-1.internal', region: 'eu', failureDomain: 'fd-1',
			capacity: { memoryMb: 300, cpus: 4, diskBytes: 10_000_000_000 }, status: 'ACTIVE',
			keyId: 'key-1', encryptedFleetKey: 'encrypted-1', createdAt: new Date(), updatedAt: new Date(),
		}],
	});
	// The app's own current 256MB is excluded from the reservation set, so the
	// node has exactly 300MB free — a 301MB resize must be refused.
	await assert.rejects(
		state.service.reconfigureMcpV3('workspace-1', command({ resources: { memoryMb: 301, cpus: 0.5, tmpSizeMb: 64 } })),
		(error: unknown) => error instanceof SchedulingError && error.code === 'CAPACITY_UNAVAILABLE',
	);
	assert.equal(state.agentCalls.length, 0);
	assert.deepEqual(state.apps[0]!.resources, { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 });
});

test('the capacity check excludes the app\'s own current reservation from its node', async () => {
	const state = fixture(runningApp(), {
		nodes: [{
			nodeId: 'node-1', url: 'https://node-1.internal', region: 'eu', failureDomain: 'fd-1',
			// Exactly enough for the resize target — if the app's own CURRENT 256MB
			// were counted against this node (i.e. not excluded), free would be
			// 512-256=256MB and this resize would be wrongly refused.
			capacity: { memoryMb: 512, cpus: 4, diskBytes: 10_000_000_000 }, status: 'ACTIVE',
			keyId: 'key-1', encryptedFleetKey: 'encrypted-1', createdAt: new Date(), updatedAt: new Date(),
		}],
	});
	await assert.doesNotReject(
		state.service.reconfigureMcpV3('workspace-1', command({ resources: { memoryMb: 512, cpus: 0.5, tmpSizeMb: 64 } })),
	);
	assert.equal(state.agentCalls.length, 1);
});

test('a later replica failing mid-resize rolls back every already-resized replica to its previous resources', async () => {
	const state = fixture(
		runningApp({
			availabilityTier: 'ha',
			replicas: [
				{ replicaId: 'replica-1', nodeId: 'node-1', containerId: 'container-1', state: 'running' },
				{ replicaId: 'replica-2', nodeId: 'node-1', containerId: 'container-2', state: 'running' },
			],
		}),
		{ failContainerIds: ['container-2'] },
	);
	await assert.rejects(
		state.service.reconfigureMcpV3('workspace-1', command({ resources: { memoryMb: 512, cpus: 1, tmpSizeMb: 64 } })),
		/agent MCP v3 reconfigure failed/,
	);
	assert.deepEqual(
		state.agentCalls.map((call) => ({ path: call.path, resources: call.body.resources })),
		[
			// forward: replica-1 resized, replica-2 fails
			{ path: '/api/v1/mcp/v3/apps/container-1/reconfigure', resources: { memoryMb: 512, cpus: 1, tmpSizeMb: 64 } },
			{ path: '/api/v1/mcp/v3/apps/container-2/reconfigure', resources: { memoryMb: 512, cpus: 1, tmpSizeMb: 64 } },
			// rollback: replica-1 restored to its previous resources
			{ path: '/api/v1/mcp/v3/apps/container-1/reconfigure', resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 } },
		],
	);
	// The whole operation was refused — nothing persisted, no billing event.
	assert.deepEqual(state.apps[0]!.resources, { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 });
	assert.equal(state.apps[0]!.appliedConfigEpoch, 1);
	assert.equal(state.lifecycleEvents.length, 0);
});

test('replaying the applied epoch with different resources is refused, even when the environment matches', async () => {
	const state = fixture();
	await state.service.reconfigureMcpV3('workspace-1', command({ resources: { memoryMb: 512, cpus: 1, tmpSizeMb: 64 } }));
	await assert.rejects(
		state.service.reconfigureMcpV3('workspace-1', command({
			jti: '66666666-6666-4666-8666-666666666666',
			resources: { memoryMb: 1024, cpus: 1, tmpSizeMb: 64 },
		})),
		(error: unknown) =>
			error instanceof McpProtocolV3Error &&
			error.code === 'CONFIG_EPOCH_INVALID' &&
			error.message === 'epoch_reused',
	);
	assert.deepEqual(state.apps[0]!.resources, { memoryMb: 512, cpus: 1, tmpSizeMb: 64 });
});

test('replaying the applied epoch with the identical resources is idempotent', async () => {
	const state = fixture();
	await state.service.reconfigureMcpV3('workspace-1', command({ resources: { memoryMb: 512, cpus: 1, tmpSizeMb: 64 } }));
	const repeat = await state.service.reconfigureMcpV3('workspace-1', command({ resources: { memoryMb: 512, cpus: 1, tmpSizeMb: 64 } }));
	assert.equal(repeat.app.appliedConfigEpoch, 2);
	assert.equal(state.agentCalls.length, 1, 'an idempotent repeat must not touch a replica again');
	assert.equal(state.lifecycleEvents.length, 1, 'an idempotent repeat must not double-emit RESIZED');
});
