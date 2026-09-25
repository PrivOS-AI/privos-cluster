/**
 * A: null-safe v3 (MCP_V3_NO_DEFAULT_HOST). Every one of these proves the
 * "no label" path never produces `undefined.<domain>` anywhere — env, the
 * agent deploy body, `publicUrlFor`, the ingress call, or the persisted app —
 * and that the flag OFF (default) is byte-identical to the pre-phase-3
 * single-replica happy path.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { jwkThumbprint } from '../security/artifacts.js';
import { DeploymentService } from './deployment-service.js';
import { KeyCipher } from './key-crypto.js';
import type { McpDeploymentGrantPayloadV3 } from '../protocol/protocol-v3.js';
import type { AppLifecycleEvent, MasterApp, MasterNode, RuntimeResourceInventory } from './types.js';

function clone<T>(value: T): T {
	return structuredClone(value);
}

function matches(record: Record<string, unknown>, filter: Record<string, unknown>): boolean {
	return Object.entries(filter).every(([key, condition]) => {
		const value = (record as Record<string, unknown>)[key];
		if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
			const operator = condition as { $ne?: unknown; $in?: unknown[]; $type?: string };
			if ('$ne' in operator) return value !== operator.$ne;
			if ('$in' in operator) return operator.$in!.includes(value);
			if ('$type' in operator) return operator.$type === 'string' ? typeof value === 'string' : true;
		}
		return value === condition;
	});
}

/**
 * Simulates the phase-3 partial unique index on `apps.subdomain`
 * (`{ subdomain: { $type: 'string' } }`): two documents sharing the SAME
 * defined subdomain collide; any number of documents with NO subdomain at
 * all never do. This is the exact invariant the migration in
 * `src/migrations/seed-host-labels.ts` establishes at the real Mongo layer.
 */
function fixture(overrides: { noDefaultHost?: boolean; emitAppPublicUrl?: boolean; legacyPublicUrlAlias?: boolean } = {}) {
	const apps: MasterApp[] = [];
	const inventories: RuntimeResourceInventory[] = [];
	const lifecycleEvents: AppLifecycleEvent[] = [];
	const now = new Date();
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' });
	const nodeKid = jwkThumbprint(publicJwk);
	const nodes: MasterNode[] = [{
		nodeId: 'node-1', url: 'https://node-1.internal', region: 'eu', failureDomain: 'fd-1',
		capacity: { memoryMb: 4096, cpus: 4, diskBytes: 10_000_000_000 }, status: 'ACTIVE',
		keyId: 'key-1', encryptedFleetKey: 'encrypted-1', createdAt: now, updatedAt: now, mcpIdentityKid: nodeKid,
	}];
	let ingressCalls = 0;
	let allocateCalls = 0;
	const deployBodies: any[] = [];

	const appsCollection = {
		findOne: async (filter: Record<string, unknown>) => clone(apps.find((row) => matches(row as unknown as Record<string, unknown>, filter)) ?? null),
		find: (filter: Record<string, unknown>) => ({
			toArray: async () => clone(apps.filter((row) => matches(row as unknown as Record<string, unknown>, filter))),
		}),
		insertOne: async (row: MasterApp & { _id?: unknown }) => {
			row._id = row._id ?? `oid-${apps.length + 1}`;
			if (apps.some((candidate) => candidate.appId === row.appId)) {
				throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { appId: 1 } });
			}
			if (
				typeof row.subdomain === 'string' &&
				apps.some((candidate) => candidate.subdomain === row.subdomain)
			) {
				throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { subdomain: 1 } });
			}
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
		replaceOne: async (filter: Record<string, unknown>, replacement: MasterApp & { _id?: unknown }) => {
			const index = apps.findIndex((candidate) => matches(candidate as unknown as Record<string, unknown>, filter));
			if (index === -1) return { matchedCount: 0 };
			// L8: the replacement's OWN subdomain can collide with a DIFFERENT,
			// live/tombstoned row — distinct from the appId match that got us
			// here at all.
			if (
				typeof replacement.subdomain === 'string' &&
				apps.some((candidate, otherIndex) => otherIndex !== index && candidate.subdomain === replacement.subdomain)
			) {
				throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { subdomain: 1 } });
			}
			const existingId = (apps[index] as MasterApp & { _id?: unknown })._id;
			apps[index] = clone({ ...replacement, ...(existingId === undefined ? {} : { _id: existingId }) });
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
			if (path.endsWith('/finalize')) return { status: 200, body: { ok: true } };
			deployBodies.push(body);
			const binding = body.mcpV3Binding;
			const descriptor = (kind: 'REPLICA' | 'CONTAINER', resourceId: string) => ({
				kind, resourceId, ownershipScope: 'INSTALLATION_GENERATION' as const,
				nodeId: node.nodeId, replicaId: binding.replicaId, attributes: { nodeIdentityKid: nodeKid },
			});
			return {
				status: 201,
				body: {
					id: binding.containerId, appId: body.appId, workspaceId: body.workspaceId,
					listingId: body.listingId, versionDigest: body.versionDigest, imageDigest: body.digest,
					state: 'running', replicaId: binding.replicaId,
					nodeIdentity: { nodeId: node.nodeId, kid: nodeKid, publicJwk },
					expectedResources: [descriptor('REPLICA', binding.replicaId), descriptor('CONTAINER', binding.containerId)],
				},
			};
		},
	};
	const service = new DeploymentService({
		repositories: repositories as any,
		agentClient: agentClient as any,
		ingress: { upsert: async () => { ingressCalls += 1; }, remove: async () => undefined } as any,
		quota: { assertDeployAllowed: async () => undefined } as any,
		subdomains: { allocate: async () => { allocateCalls += 1; return 'library-app'; } } as any,
		locks: { run: async (_workspaceId: string, work: () => Promise<unknown>) => work() } as any,
		baseDomain: 'apps.example.com',
		cipher: new KeyCipher(Buffer.alloc(32, 7)),
		noDefaultHost: overrides.noDefaultHost,
		emitAppPublicUrl: overrides.emitAppPublicUrl,
		legacyPublicUrlAlias: overrides.legacyPublicUrlAlias,
	});
	return { apps, inventories, service, deployBodies, get ingressCalls() { return ingressCalls; }, get allocateCalls() { return allocateCalls; } };
}

function grant(overrides: Partial<McpDeploymentGrantPayloadV3> = {}): McpDeploymentGrantPayloadV3 {
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
			availabilityTier: 'single', stateless: false,
			releaseAttestationJws: 'signed.release.attestation.'.padEnd(40, 'x'),
			subdomain: null, domain: null,
		},
		...overrides,
	};
}

test('publicUrlFor returns undefined for an absent primary, never "undefined.<domain>"', () => {
	const { service } = fixture();
	assert.equal(service.publicUrlFor(undefined), undefined);
	assert.equal(service.publicUrlFor('library-app'), 'https://library-app.apps.example.com');
});

test('MCP_V3_NO_DEFAULT_HOST on: a v3 create with no Hub-chosen subdomain allocates no label at all', async () => {
	const { service, apps, deployBodies, ingressCalls, allocateCalls } = fixture({ noDefaultHost: true });
	const { app } = await service.deployMcpV3('workspace-1', grant(), 'grant-hash', { kid: 'hub-kid', publicJwk: {} as any });

	assert.equal(allocateCalls, 0, 'the legacy random allocator must never run when the flag is on');
	assert.equal(app.subdomain, undefined);
	assert.equal(app.uiUrl, undefined);
	assert.equal(apps[0]!.subdomain, undefined);
	assert.equal('subdomain' in apps[0]!, false, 'the field must be OMITTED, not stored as null/undefined');

	// The agent deploy body carries an explicit null, never the string "undefined".
	assert.equal(deployBodies[0].subdomain, null);
	assert.ok(!JSON.stringify(deployBodies[0]).includes('undefined'), 'no request body may contain the literal string "undefined"');

	// No label → PRIVOS_APP_PUBLIC_URL/PRIVOS_PUBLIC_URL are absent, not `undefined`.
	assert.deepEqual(deployBodies[0].platformEnvVars, { PRIVOS_ACCESS_MODE: 'managed-runtime' });

	assert.equal(service.publicUrlFor(app.subdomain), undefined);
	assert.equal(ingressCalls, 0, 'no label means nothing for the legacy CNAME programmer to point anywhere');
});

test('MCP_V3_NO_DEFAULT_HOST off (default): byte-identical to the legacy random-label path', async () => {
	const { service, apps, deployBodies } = fixture({ noDefaultHost: false });
	const { app } = await service.deployMcpV3('workspace-1', grant(), 'grant-hash', { kid: 'hub-kid', publicJwk: {} as any });

	assert.equal(app.subdomain, 'library-app');
	assert.equal(app.uiUrl, 'https://library-app.apps.example.com');
	assert.equal(apps[0]!.subdomain, 'library-app');
	// M5: MCP_EMIT_APP_PUBLIC_URL also defaults off — this stays byte-identical
	// to pre-rename behaviour, only the legacy key.
	assert.deepEqual(deployBodies[0].platformEnvVars, {
		PRIVOS_PUBLIC_URL: 'https://library-app.apps.example.com',
		PRIVOS_ACCESS_MODE: 'managed-runtime',
	});
});

test('M5: MCP_EMIT_APP_PUBLIC_URL off (default) never emits the renamed key, even with a primary host — an older agent must never 400', async () => {
	const { deployBodies, service } = fixture({ noDefaultHost: false, emitAppPublicUrl: false });
	await service.deployMcpV3('workspace-1', grant(), 'grant-hash', { kid: 'hub-kid', publicJwk: {} as any });
	assert.deepEqual(deployBodies[0].platformEnvVars, {
		PRIVOS_PUBLIC_URL: 'https://library-app.apps.example.com',
		PRIVOS_ACCESS_MODE: 'managed-runtime',
	});
	assert.equal('PRIVOS_APP_PUBLIC_URL' in deployBodies[0].platformEnvVars, false);
});

test('M5: MCP_EMIT_APP_PUBLIC_URL on + MCP_LEGACY_PUBLIC_URL_ALIAS on (default): both keys, same value', async () => {
	const { deployBodies, service } = fixture({ noDefaultHost: false, emitAppPublicUrl: true });
	await service.deployMcpV3('workspace-1', grant(), 'grant-hash', { kid: 'hub-kid', publicJwk: {} as any });
	assert.deepEqual(deployBodies[0].platformEnvVars, {
		PRIVOS_APP_PUBLIC_URL: 'https://library-app.apps.example.com',
		PRIVOS_PUBLIC_URL: 'https://library-app.apps.example.com',
		PRIVOS_ACCESS_MODE: 'managed-runtime',
	});
});

test('M5: MCP_EMIT_APP_PUBLIC_URL on + MCP_LEGACY_PUBLIC_URL_ALIAS off: only the renamed key is emitted', async () => {
	const { deployBodies, service } = fixture({ noDefaultHost: false, emitAppPublicUrl: true, legacyPublicUrlAlias: false });
	await service.deployMcpV3('workspace-1', grant(), 'grant-hash', { kid: 'hub-kid', publicJwk: {} as any });
	assert.deepEqual(deployBodies[0].platformEnvVars, {
		PRIVOS_APP_PUBLIC_URL: 'https://library-app.apps.example.com',
		PRIVOS_ACCESS_MODE: 'managed-runtime',
	});
});

test('two host-less v3 apps in one workspace never collide on the (partial-indexed) subdomain field', async () => {
	const { service, apps } = fixture({ noDefaultHost: true });
	const first = await service.deployMcpV3('workspace-1', grant(), 'grant-hash', { kid: 'hub-kid', publicJwk: {} as any });
	const second = await service.deployMcpV3(
		'workspace-1',
		grant({
			generationId: 'generation-2',
			jti: '22222222-2222-4222-8222-222222222222',
			deployment: { ...grant().deployment, clusterAppId: 'cluster-app-2', listingId: 'listing-2' },
		}),
		'grant-hash-2',
		{ kid: 'hub-kid', publicJwk: {} as any },
	);
	assert.equal(apps.length, 2);
	assert.equal(first.app.subdomain, undefined);
	assert.equal(second.app.subdomain, undefined);
});

test('an explicit Hub-chosen subdomain that collides with another app raises a distinct, coded conflict — never a generic duplicate_app_row', async () => {
	const { service } = fixture();
	await service.deployMcpV3('workspace-1', grant(), 'grant-hash', { kid: 'hub-kid', publicJwk: {} as any });
	await assert.rejects(
		service.deployMcpV3(
			'workspace-1',
			grant({
				generationId: 'generation-2',
				jti: '22222222-2222-4222-8222-222222222222',
				deployment: { ...grant().deployment, clusterAppId: 'cluster-app-2', listingId: 'listing-2', subdomain: 'library-app' },
			}),
			'grant-hash-2',
			{ kid: 'hub-kid', publicJwk: {} as any },
		),
		(error: any) => {
			assert.equal(error.code, 'mcp_v3_deployment_subdomain_conflict');
			assert.equal(error.statusCode, 409);
			return true;
		},
	);
});

test('L8: reviving an appId tombstone with a foreign subdomain surfaces the clean 409, never a raw replaceOne E11000', async () => {
	const { service, apps } = fixture();
	const now = new Date();
	// A prior uninstall tombstoned THIS appId (any subdomain of its own).
	apps.push({
		appId: 'cluster-app-1', workspaceId: 'workspace-1', listingId: 'listing-1', versionDigest: 'sha256:' + 'a'.repeat(64),
		image: 'img', imageDigest: 'sha256:' + 'a'.repeat(64), resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 },
		port: 3001, envVars: {}, volumes: [], storageBytes: 0, availabilityTier: 'single', stateless: false,
		subdomain: 'old-tombstoned-label', uiUrl: 'https://old-tombstoned-label.apps.example.com',
		replicas: [], state: 'REMOVED', createdAt: now, updatedAt: now, kind: 'mcp-v3',
	} as MasterApp);
	// A DIFFERENT, unrelated app already owns the label the reinstall's grant
	// explicitly names.
	apps.push({
		appId: 'someone-elses-app', workspaceId: 'workspace-1', listingId: 'listing-99', versionDigest: 'sha256:' + 'b'.repeat(64),
		image: 'img', imageDigest: 'sha256:' + 'b'.repeat(64), resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 },
		port: 3001, envVars: {}, volumes: [], storageBytes: 0, availabilityTier: 'single', stateless: false,
		subdomain: 'foreign-label', uiUrl: 'https://foreign-label.apps.example.com',
		replicas: [], state: 'RUNNING', createdAt: now, updatedAt: now, kind: 'mcp-v3',
	} as MasterApp);

	await assert.rejects(
		service.deployMcpV3(
			'workspace-1',
			grant({ deployment: { ...grant().deployment, subdomain: 'foreign-label' } }),
			'grant-hash',
			{ kid: 'hub-kid', publicJwk: {} as any },
		),
		(error: any) => {
			assert.equal(error.code, 'mcp_v3_deployment_subdomain_conflict');
			assert.equal(error.statusCode, 409);
			assert.notEqual(error.message, 'duplicate');
			return true;
		},
	);
});
