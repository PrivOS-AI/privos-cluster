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

function fixture(app: MasterApp = runningApp()) {
	const apps = [structuredClone(app)];
	const nodes: MasterNode[] = [{
		nodeId: 'node-1', url: 'https://node-1.internal', region: 'eu', failureDomain: 'fd-1',
		capacity: { memoryMb: 4096, cpus: 4, diskBytes: 10_000_000_000 }, status: 'ACTIVE',
		keyId: 'key-1', encryptedFleetKey: 'encrypted-1', createdAt: new Date(), updatedAt: new Date(),
	}];
	const agentCalls: Array<{ path: string; body: any }> = [];
	const service = new DeploymentService({
		repositories: {
			apps: {
				findOne: async () => structuredClone(apps[0] ?? null),
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
		} as any,
		agentClient: {
			request: async (_node: MasterNode, _ws: string, _method: string, path: string, body: any) => {
				agentCalls.push({ path, body });
				return { status: 200, body: { ok: true } };
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
