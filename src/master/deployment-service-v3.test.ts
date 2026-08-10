import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { jwkThumbprint, sha256Base64Url } from '../security/artifacts.js';
import { DeploymentService } from './deployment-service.js';
import { KeyCipher } from './key-crypto.js';
import type { McpDeploymentGrantPayloadV3 } from './protocol-v3.js';
import type { AppLifecycleEvent, MasterApp, MasterNode, RuntimeResourceInventory } from './types.js';

function clone<T>(value: T): T {
	return structuredClone(value);
}

function valuesAt(record: Record<string, unknown>, path: string): unknown[] {
	let values: unknown[] = [record];
	for (const part of path.split('.')) {
		values = values.flatMap((value) => {
			if (Array.isArray(value)) return value.flatMap((item) => valuesAt(item as Record<string, unknown>, part));
			if (!value || typeof value !== 'object') return [undefined];
			const next = (value as Record<string, unknown>)[part];
			return Array.isArray(next) ? next : [next];
		});
	}
	return values;
}

function matches(record: Record<string, unknown>, filter: Record<string, unknown>): boolean {
	return Object.entries(filter).every(([path, condition]) => {
		const values = valuesAt(record, path);
		if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
			const operator = condition as { $ne?: unknown; $in?: unknown[] };
			if ('$ne' in operator) return values.every((value) => value !== operator.$ne);
			if ('$in' in operator) return values.some((value) => operator.$in!.includes(value));
		}
		return values.some((value) => value === condition);
	});
}

function fixture() {
	const apps: MasterApp[] = [];
	const inventories: RuntimeResourceInventory[] = [];
	const lifecycleEvents: AppLifecycleEvent[] = [];
	const now = new Date();
	const nodes: MasterNode[] = [
		{
			nodeId: 'node-1', url: 'https://node-1.internal', region: 'eu', failureDomain: 'fd-1',
			capacity: { memoryMb: 4096, cpus: 4, diskBytes: 10_000_000_000 }, status: 'ACTIVE',
			keyId: 'key-1', encryptedFleetKey: 'encrypted-1', createdAt: now, updatedAt: now,
		},
		{
			nodeId: 'node-2', url: 'https://node-2.internal', region: 'eu', failureDomain: 'fd-2',
			capacity: { memoryMb: 4096, cpus: 4, diskBytes: 10_000_000_000 }, status: 'ACTIVE',
			keyId: 'key-2', encryptedFleetKey: 'encrypted-2', createdAt: now, updatedAt: now,
		},
	];
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' });
	const nodeKid = jwkThumbprint(publicJwk);
	const deployCalls = new Map<string, number>();
	const finalized: Array<{ nodeId: string; containerId: string; hash: string }> = [];
	let failNode2Once = true;
	let ingressCalls = 0;

	const appsCollection = {
		findOne: async (filter: Record<string, unknown>) => clone(apps.find((row) => matches(row as unknown as Record<string, unknown>, filter)) ?? null),
		find: (filter: Record<string, unknown>) => ({
			toArray: async () => clone(apps.filter((row) => matches(row as unknown as Record<string, unknown>, filter))),
		}),
		insertOne: async (row: MasterApp) => {
			if (apps.some((candidate) => candidate.appId === row.appId)) throw Object.assign(new Error('duplicate'), { code: 11000 });
			apps.push(clone(row));
			return { acknowledged: true };
		},
		updateOne: async (filter: Record<string, unknown>, update: { $set?: Partial<MasterApp>; $push?: { replicas: MasterApp['replicas'][number] } }) => {
			const row = apps.find((candidate) => matches(candidate as unknown as Record<string, unknown>, filter));
			if (!row) return { matchedCount: 0 };
			if (update.$set) Object.assign(row, clone(update.$set));
			if (update.$push?.replicas) row.replicas.push(clone(update.$push.replicas));
			return { matchedCount: 1 };
		},
		replaceOne: async (filter: Record<string, unknown>, replacement: MasterApp) => {
			const index = apps.findIndex((candidate) => matches(candidate as unknown as Record<string, unknown>, filter));
			if (index === -1) return { matchedCount: 0 };
			apps[index] = clone(replacement);
			return { matchedCount: 1 };
		},
	};
	const inventoryCollection = {
		findOne: async (filter: Record<string, unknown>) => clone(inventories.find((row) => matches(row as unknown as Record<string, unknown>, filter)) ?? null),
		insertOne: async (row: RuntimeResourceInventory) => {
			if (inventories.some((candidate) => candidate.inventoryId === row.inventoryId)) throw Object.assign(new Error('duplicate'), { code: 11000 });
			inventories.push(clone(row));
			return { acknowledged: true };
		},
		updateOne: async (filter: Record<string, unknown>, update: {
			$set?: Partial<RuntimeResourceInventory>;
			$addToSet?: { expectedResources: RuntimeResourceInventory['expectedResources'][number] | { $each: RuntimeResourceInventory['expectedResources'] } };
		}) => {
			const row = inventories.find((candidate) => matches(candidate as unknown as Record<string, unknown>, filter));
			if (!row) return { matchedCount: 0 };
			const addition = update.$addToSet?.expectedResources;
			const resources = addition && '$each' in addition ? addition.$each : addition ? [addition] : [];
			for (const resource of resources) {
				if (!row.expectedResources.some((candidate) => JSON.stringify(candidate) === JSON.stringify(resource))) {
					row.expectedResources.push(clone(resource));
				}
			}
			if (update.$set) Object.assign(row, clone(update.$set));
			return { matchedCount: 1 };
		},
	};
	const repositories = {
		apps: appsCollection,
		nodes: {
			find: (filter: Record<string, unknown>) => ({
				toArray: async () => clone(nodes.filter((row) => matches(row as unknown as Record<string, unknown>, filter))),
			}),
		},
		runtimeResourceInventories: inventoryCollection,
		lifecycleEvents: {
			insertOne: async (event: AppLifecycleEvent) => {
				if (lifecycleEvents.some((candidate) => candidate.eventId === event.eventId)) throw Object.assign(new Error('duplicate'), { code: 11000 });
				lifecycleEvents.push(clone(event));
			},
		},
	};
	const agentClient = {
		request: async (node: MasterNode, _workspaceId: string, _method: string, path: string, body: any) => {
			if (path.endsWith('/finalize')) {
				finalized.push({ nodeId: node.nodeId, containerId: path.split('/').at(-2)!, hash: body.runtimeResourceInventoryHash });
				return { status: 200, body: { ok: true } };
			}
			const call = (deployCalls.get(node.nodeId) ?? 0) + 1;
			deployCalls.set(node.nodeId, call);
			if (node.nodeId === 'node-2' && failNode2Once) {
				failNode2Once = false;
				return { status: 503, body: { error: 'injected_failure' } };
			}
			const binding = body.mcpV3Binding;
			const descriptor = (kind: 'REPLICA' | 'CONTAINER', resourceId: string) => ({
				kind,
				resourceId,
				ownershipScope: 'INSTALLATION_GENERATION' as const,
				nodeId: node.nodeId,
				replicaId: binding.replicaId,
				attributes: { nodeIdentityKid: nodeKid },
			});
			return {
				status: 201,
				body: {
					id: binding.containerId,
					appId: body.appId,
					workspaceId: body.workspaceId,
					listingId: body.listingId,
					versionDigest: body.versionDigest,
					imageDigest: body.digest,
					state: 'running',
					replicaId: binding.replicaId,
					nodeIdentity: { nodeId: node.nodeId, kid: nodeKid, publicJwk },
					expectedResources: [
						descriptor('REPLICA', binding.replicaId),
						descriptor('CONTAINER', binding.containerId),
						{
							kind: 'BROKER_SOCKET', resourceId: `broker-${node.nodeId}`,
							ownershipScope: 'INSTALLATION_GENERATION', nodeId: node.nodeId,
							replicaId: binding.replicaId, attributes: {},
						},
					],
				},
			};
		},
	};
	const service = new DeploymentService({
		repositories: repositories as any,
		agentClient: agentClient as any,
		ingress: { upsert: async () => { ingressCalls += 1; } } as any,
		quota: { assertDeployAllowed: async () => undefined } as any,
		subdomains: { allocate: async () => 'library-app' } as any,
		locks: { run: async (_workspaceId: string, work: () => Promise<unknown>) => work() } as any,
		baseDomain: 'apps.example.com',
		cipher: new KeyCipher(Buffer.alloc(32, 7)),
	});
	return {
		apps, inventories, lifecycleEvents, deployCalls, finalized, service,
		get ingressCalls() { return ingressCalls; },
		hubIdentity: { kid: nodeKid, publicJwk },
	};
}

function grant(): McpDeploymentGrantPayloadV3 {
	const now = Math.floor(Date.now() / 1000);
	return {
		protocolVersion: 3,
		type: 'mcp-deployment-grant',
		iss: 'urn:privos:hub:deployment-1',
		aud: 'privos-apps-master',
		jti: '11111111-1111-4111-8111-111111111111',
		nonce: 'provisioning-nonce-123456',
		iat: now,
		exp: now + 120,
		clusterId: 'cluster-1',
		workspaceId: 'workspace-1',
		deploymentId: 'deployment-1',
		generationId: 'generation-1',
		generationNumber: 1,
		runtimeInstallationId: 'runtime-1',
		mcpAppId: 'mcp-app-1',
		acquisitionAffinityHash: 'a'.repeat(43),
		approvalReceiptHash: 'b'.repeat(43),
		approvedPermissionCeilingHash: 'c'.repeat(43),
		authorizationEpoch: 7,
		hubOrigin: 'https://hub.example.com',
		deployment: {
			clusterAppId: 'cluster-app-1', listingId: 'listing-1', versionId: 'version-1',
			versionDigest: `sha256:${'d'.repeat(64)}`,
			image: `registry.example/app@sha256:${'e'.repeat(64)}`,
			imageDigest: `sha256:${'e'.repeat(64)}`,
			manifestDigest: `sha256:${'f'.repeat(64)}`,
			resourceManifestHash: 'r'.repeat(43), port: 3001,
			resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 }, envVars: {}, volumes: [],
			availabilityTier: 'ha', stateless: true,
			releaseAttestationJws: 'signed.release.attestation.'.padEnd(40, 'x'),
			subdomain: null, domain: null,
		},
	};
}

test('v3 provisioning persists exact partial resources, resumes deterministically, and establishes activation', async () => {
	const state = fixture();
	const deploymentGrant = grant();
	const deploymentGrantHash = 'g'.repeat(43);

	await assert.rejects(
		state.service.deployMcpV3('workspace-1', deploymentGrant, deploymentGrantHash, state.hubIdentity),
		/agent MCP v3 deploy failed/,
	);
	assert.equal(state.apps.length, 1);
	assert.equal(state.apps[0]!.state, 'PROVISIONING');
	assert.equal(state.apps[0]!.replicas.length, 1);
	assert.equal(state.apps[0]!.mcpProvisioningReplicas?.length, 2);
	assert.equal(state.apps[0]!.mcpRoomBindingCount, 0);
	assert.equal(state.apps[0]!.mcpActiveDeploymentKey, 'deployment-1');
	assert.equal((state.apps[0] as any).approvedPermissionCeiling, undefined);
	assert.deepEqual(
		Object.keys(state.apps[0]!).filter((key) => key.toLowerCase().includes('permission')),
		['mcpApprovedPermissionCeilingHash'],
	);
	assert.equal(state.inventories[0]!.state, 'CAPTURING');
	assert.equal(state.inventories[0]!.runtimeResourceInventoryHash, undefined);
	assert.equal(state.inventories[0]!.expectedResources.length, 3);

	const completed = await state.service.deployMcpV3(
		'workspace-1', deploymentGrant, deploymentGrantHash, state.hubIdentity,
	);
	assert.equal(completed.app.state, 'QUARANTINED');
	assert.equal(completed.app.replicas.length, 2);
	assert.equal(completed.inventory.state, 'READY');
	assert.match(completed.inventory.runtimeResourceInventoryHash, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(completed.inventory.expectedResources.length, 7);
	assert.equal(completed.inventory.expectedResources.some((resource) => resource.ownershipScope === 'ROOM_BINDING'), false);
	assert.equal(state.deployCalls.get('node-1'), 1);
	assert.equal(state.deployCalls.get('node-2'), 2);
	assert.equal(state.finalized.length, 2);
	assert.equal(new Set(state.finalized.map((entry) => entry.hash)).size, 1);

	const retried = await state.service.deployMcpV3(
		'workspace-1', deploymentGrant, deploymentGrantHash, state.hubIdentity,
	);
	assert.equal(retried.inventory.runtimeResourceInventoryHash, completed.inventory.runtimeResourceInventoryHash);
	assert.equal(state.deployCalls.get('node-1'), 1);
	assert.equal(state.deployCalls.get('node-2'), 2);

	const persistedInventory = state.inventories[0]!;
	const attestationCompact = 'header.payload.signature';
	const attestationHash = sha256Base64Url(attestationCompact);
	persistedInventory.runtimeInventoryAttestation = {
		deploymentGrantJti: deploymentGrant.jti,
		jti: '22222222-2222-4222-8222-222222222222',
		payload: {} as any,
		compact: attestationCompact,
		artifactHash: attestationHash,
		attestedAt: new Date(),
	};
	await assert.rejects(state.service.activateMcpV3('workspace-1', {
		runtimeInstallationId: deploymentGrant.runtimeInstallationId,
		compact: 'wrong',
		artifactHash: attestationHash,
	}), /runtime_inventory_attestation_establishment_mismatch/);
	const running = await state.service.activateMcpV3('workspace-1', {
		runtimeInstallationId: deploymentGrant.runtimeInstallationId,
		compact: attestationCompact,
		artifactHash: attestationHash,
	});
	assert.equal(running.state, 'RUNNING');
	assert.ok(running.mcpInventoryAttestationEstablishedAt);
	assert.equal(state.ingressCalls, 1);
	assert.equal(state.lifecycleEvents.length, 2);
	const identicalActivation = await state.service.activateMcpV3('workspace-1', {
		runtimeInstallationId: deploymentGrant.runtimeInstallationId,
		compact: attestationCompact,
		artifactHash: attestationHash,
	});
	assert.equal(identicalActivation.state, 'RUNNING');
	assert.equal(state.ingressCalls, 1);
});

test('reinstalling over the tombstone of a previous install revives it instead of failing', async () => {
	const state = fixture();
	const deploymentGrant = grant();
	const deploymentGrantHash = 'g'.repeat(43);

	// What a previous install leaves behind: uninstall keeps the row at REMOVED, and the Portal
	// hands out the same clusterAppId again because it reuses one deployment-app slot per
	// (listing, deployment). Before the revive, insertOne hit the unique appId index and the
	// duplicate-key branch only looked for a live row, so the reinstall died as a bare 500.
	state.apps.push({
		appId: deploymentGrant.deployment.clusterAppId,
		workspaceId: 'workspace-1',
		kind: 'mcp-v3',
		state: 'REMOVED',
		replicas: [],
		mcpDeploymentId: 'deployment-0',
		mcpGenerationNumber: 1,
	} as unknown as MasterApp);

	await assert.rejects(
		state.service.deployMcpV3('workspace-1', deploymentGrant, deploymentGrantHash, state.hubIdentity),
		/agent MCP v3 deploy failed/,
	);

	// One row, revived in place — the slot identity is stable, so a second row would be wrong.
	assert.equal(state.apps.length, 1);
	assert.equal(state.apps[0]!.appId, deploymentGrant.deployment.clusterAppId);
	assert.equal(state.apps[0]!.state, 'PROVISIONING');
	assert.equal(state.apps[0]!.mcpDeploymentId, 'deployment-1');
	assert.equal(state.apps[0]!.mcpGenerationId, deploymentGrant.generationId);
});
