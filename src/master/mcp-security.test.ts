import assert from 'node:assert/strict';
import crypto, { type JsonWebKey } from 'node:crypto';
import test from 'node:test';

import { canonicalJson, jwkThumbprint, sha256Base64Url, signEs256Jws } from '../security/artifacts.js';
import { McpSecurityVerifier, verifyMarketplaceReleaseAttestation } from './mcp-security.js';
import { buildRuntimeResourceInventoryV3 } from './runtime-resource-inventory.js';
import type { MasterWorkspace } from './types.js';

function identity() {
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const privateJwk = pair.privateKey.export({ format: 'jwk' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' });
	return { privateJwk, publicJwk, kid: jwkThumbprint(publicJwk) };
}

function repositories(workspaceIds: string[]) {
	const rows = new Map<string, MasterWorkspace>(workspaceIds.map((workspaceId) => [workspaceId, {
		workspaceId,
		keyHash: 'hash',
		encryptedKey: 'encrypted',
		quota: { maxMemoryMb: 1024, maxCpus: 1, maxApps: 2 },
		defaultAvailabilityTier: 'single',
		status: 'ACTIVE',
		createdAt: new Date(),
		updatedAt: new Date(),
	}]));
	const artifacts = new Set<string>();
	const v3Artifacts = new Map<string, any>();
	const runtimeInventories: any[] = [];
	return {
		rows,
		runtimeInventories,
		v3Artifacts,
		repositories: {
			workspaces: {
				findOne: async (filter: { workspaceId: string; status?: string }) => {
					const row = rows.get(filter.workspaceId);
					return row && (!filter.status || row.status === filter.status) ? row : null;
				},
				updateOne: async (filter: { workspaceId: string }, update: { $set: Partial<MasterWorkspace> }) => {
					const row = rows.get(filter.workspaceId);
					if (!row || row.mcpHubIdentityKid || row.mcpHubIdentityPublicJwk) return { matchedCount: 0 };
					rows.set(filter.workspaceId, { ...row, ...update.$set });
					return { matchedCount: 1 };
				},
			},
			mcpArtifactUses: {
				insertOne: async (record: { _id: string }) => {
					if (artifacts.has(record._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
					artifacts.add(record._id);
				},
			},
			mcpProtocolV3ArtifactUses: {
				insertOne: async (record: {
					_id: string; kind: string; nonce: string; clusterId?: string; workspaceId?: string;
					deploymentId?: string; generationId?: string;
				}) => {
					if (
						v3Artifacts.has(record._id) ||
						[...v3Artifacts.values()].some((existing) =>
							existing.kind === record.kind && (
								existing.nonce === record.nonce ||
								(record.kind === 'deployment-grant' &&
									existing.clusterId === record.clusterId &&
									existing.workspaceId === record.workspaceId &&
									existing.deploymentId === record.deploymentId &&
									existing.generationId === record.generationId)
							))
					) throw Object.assign(new Error('duplicate'), { code: 11000 });
					v3Artifacts.set(record._id, record);
				},
				findOne: async (filter: { kind: string; $or: Array<{ _id?: string; nonce?: string }> }) =>
					[...v3Artifacts.values()].find((record) =>
						record.kind === filter.kind && filter.$or.some((part) =>
							(part._id !== undefined && part._id === record._id) ||
							(part.nonce !== undefined && part.nonce === record.nonce))) ?? null,
			},
			apps: {
				findOne: async () => null,
			},
			runtimeResourceInventories: {
				findOne: async (filter: Record<string, unknown>) => runtimeInventories.find((inventory) =>
					Object.entries(filter).every(([key, value]) => inventory[key] === value)) ?? null,
			},
		} as any,
	};
}

function lifecycleCommand(input: {
	clusterId: string;
	workspaceId: string;
	key: ReturnType<typeof identity>;
	nonce?: string;
	runtimeResourceInventoryHash: string;
	expectedResourceCount?: number;
}): string {
	const now = Math.floor(Date.now() / 1000);
	return signEs256Jws({
		privateJwk: input.key.privateJwk,
		kid: input.key.kid,
		typ: 'privos-cluster-lifecycle-command+jws',
		protocolVersion: 3,
		payload: {
			protocolVersion: 3,
			type: 'cluster-lifecycle-command',
			iss: 'urn:privos:hub:deployment-1',
			aud: 'privos-apps-master',
			jti: crypto.randomUUID(),
			nonce: input.nonce ?? crypto.randomBytes(24).toString('base64url'),
			iat: now,
			exp: now + 120,
			action: 'UNINSTALL_RUNTIME',
			operationId: '11111111-1111-4111-8111-111111111111',
			clusterId: input.clusterId,
			workspaceId: input.workspaceId,
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 1,
			runtimeInstallationId: 'runtime-1',
			clusterAppId: 'cluster-app-1',
			manifestDigest: `sha256:${'a'.repeat(64)}`,
			resourceManifestHash: 'r'.repeat(43),
			runtimeResourceInventoryHash: input.runtimeResourceInventoryHash,
			reasonCode: 'ADMIN_UNINSTALL',
			expectedResourceCount: input.expectedResourceCount ?? 1,
		},
	});
}

function enrollmentProof(input: { clusterId: string; workspaceId: string; deploymentId?: string; key: ReturnType<typeof identity> }): string {
	const now = Math.floor(Date.now() / 1000);
	return signEs256Jws({
		privateJwk: input.key.privateJwk,
		kid: input.key.kid,
		typ: 'privos-hub-identity-enrollment+jws',
		payload: {
			type: 'mcp-hub-identity-enrollment',
			aud: 'privos-apps-master',
			jti: crypto.randomUUID(),
			iat: now,
			exp: now + 120,
			clusterId: input.clusterId,
			workspaceId: input.workspaceId,
			deploymentId: input.deploymentId ?? input.workspaceId,
			kid: input.key.kid,
		},
	});
}

function deploymentGrant(input: { clusterId: string; workspaceId: string; key: ReturnType<typeof identity> }): string {
	const now = Math.floor(Date.now() / 1000);
	const digest = `sha256:${'a'.repeat(64)}`;
	return signEs256Jws({
		privateJwk: input.key.privateJwk,
		kid: input.key.kid,
		typ: 'privos-deployment-grant+jws',
		payload: {
			type: 'mcp-deployment-grant',
			aud: 'privos-apps-master',
			jti: crypto.randomUUID(),
			iat: now,
			exp: now + 120,
			clusterId: input.clusterId,
			workspaceId: input.workspaceId,
			installationId: 'installation-1',
			mcpAppId: 'app-1',
			receiptHash: digest,
			grantEpoch: 1,
			hubOrigin: 'https://workspace.privos.io',
			deployment: {
				appId: 'cluster-app-1',
				listingId: 'listing-1',
				versionDigest: digest,
				image: 'registry.example/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				imageDigest: digest,
				manifestDigest: digest,
				port: 3001,
				resources: { memoryMb: 128, cpus: 0.1, tmpSizeMb: 64 },
				envVars: {},
				volumes: [],
				availabilityTier: 'single',
				stateless: true,
				releaseAttestationJws: 'header.payload.signature-release-attestation',
			},
		},
	});
}

function deploymentGrantV3(input: {
	clusterId: string;
	workspaceId: string;
	key: ReturnType<typeof identity>;
	generationId: string;
	generationNumber: number;
	runtimeInstallationId: string;
	jti?: string;
	nonce?: string;
	issuedAt?: number;
}): string {
	const now = input.issuedAt ?? Math.floor(Date.now() / 1000);
	return signEs256Jws({
		privateJwk: input.key.privateJwk,
		kid: input.key.kid,
		typ: 'privos-deployment-grant+jws',
		protocolVersion: 3,
		payload: {
			protocolVersion: 3,
			type: 'mcp-deployment-grant',
			iss: 'urn:privos:hub:deployment-1',
			aud: 'privos-apps-master',
			jti: input.jti ?? crypto.randomUUID(),
			nonce: input.nonce ?? crypto.randomBytes(24).toString('base64url'),
			iat: now,
			exp: now + 120,
			clusterId: input.clusterId,
			workspaceId: input.workspaceId,
			deploymentId: 'deployment-1',
			generationId: input.generationId,
			generationNumber: input.generationNumber,
			runtimeInstallationId: input.runtimeInstallationId,
			mcpAppId: 'mcp-app-1',
			acquisitionAffinityHash: 'a'.repeat(43),
			approvalReceiptHash: 'b'.repeat(43),
			approvedPermissionCeilingHash: 'c'.repeat(43),
			authorizationEpoch: 2,
			hubOrigin: 'https://hub.example.com',
			deployment: {
				clusterAppId: 'cluster-app-1',
				listingId: 'listing-1',
				versionId: 'version-1',
				versionDigest: `sha256:${'d'.repeat(64)}`,
				image: `registry.example/app@sha256:${'e'.repeat(64)}`,
				imageDigest: `sha256:${'e'.repeat(64)}`,
				manifestDigest: `sha256:${'f'.repeat(64)}`,
				resourceManifestHash: 'r'.repeat(43),
				port: 3001,
				resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 },
				envVars: {},
				volumes: [],
				availabilityTier: 'single',
				stateless: true,
				releaseAttestationJws: 'signed.release.attestation.'.padEnd(40, 'x'),
				subdomain: null,
				domain: null,
			},
		},
	});
}

function dispatchAssertionV3(input: {
	clusterId: string;
	workspaceId: string;
	key: ReturnType<typeof identity>;
	rpc: unknown;
	authorizationContext: 'workspace' | 'room';
	authorizationBindingId?: string;
	runtimeInstallationId?: string;
	runtimeGrantEpoch?: number;
}): string {
	const now = Math.floor(Date.now() / 1000);
	return signEs256Jws({
		privateJwk: input.key.privateJwk,
		kid: input.key.kid,
		typ: 'privos-hub-dispatch+jws',
		protocolVersion: 3,
		payload: {
			protocolVersion: 3,
			type: 'hub-dispatch-assertion',
			iss: 'urn:privos:hub:deployment-1',
			aud: 'privos-mcp-app',
			jti: crypto.randomUUID(),
			nonce: crypto.randomBytes(24).toString('base64url'),
			iat: now,
			exp: now + 30,
			clusterId: input.clusterId,
			workspaceId: input.workspaceId,
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 1,
			runtimeInstallationId: input.runtimeInstallationId ?? 'runtime-1',
			mcpAppId: 'mcp-app-1',
			clusterAppId: 'cluster-app-1',
			htm: 'POST',
			htu: '/mcp',
			bodyDigest: sha256Base64Url(canonicalJson(input.rpc)),
			manifestDigest: `sha256:${'f'.repeat(64)}`,
			resourceManifestHash: 'r'.repeat(43),
			runtimeResourceInventoryHash: 'i'.repeat(43),
			runtimeApprovalReceiptHash: 'b'.repeat(43),
			runtimeGrantEpoch: input.runtimeGrantEpoch ?? 7,
			authorizationContext: input.authorizationContext,
			...(input.authorizationContext === 'room' ? {
				roomId: 'room-1',
				authorizationBindingId: input.authorizationBindingId ?? 'binding-1',
				bindingReceiptHash: 'q'.repeat(43),
				bindingEpoch: 2,
			} : {}),
		},
	});
}

test('Hub identities enroll independently per authenticated workspace and reject substitution', async () => {
	const clusterId = 'privos-app-cluster';
	const state = repositories(['workspace-a', 'workspace-b']);
	const verifier = new McpSecurityVerifier(state.repositories, clusterId);
	const first = identity();
	const second = identity();

	await verifier.enrollHubIdentity({
		workspaceId: 'workspace-a',
		publicJwk: first.publicJwk,
		compact: enrollmentProof({ clusterId, workspaceId: 'workspace-a', key: first }),
	});
	await verifier.enrollHubIdentity({
		workspaceId: 'workspace-b',
		publicJwk: second.publicJwk,
		compact: enrollmentProof({ clusterId, workspaceId: 'workspace-b', key: second }),
	});
	assert.equal((await verifier.publicInfo('workspace-a'))?.kid, first.kid);
	assert.equal((await verifier.publicInfo('workspace-b'))?.kid, second.kid);

	await assert.rejects(
		verifier.enrollHubIdentity({
			workspaceId: 'workspace-a',
			publicJwk: second.publicJwk,
			compact: enrollmentProof({ clusterId, workspaceId: 'workspace-a', key: second }),
		}),
		/hub_identity_conflict/,
	);
});

test('detached Marketplace release attestation binds the exact reviewed image and manifest', () => {
	const pair = crypto.generateKeyPairSync('ed25519');
	const privateKey = pair.privateKey;
	const publicJwk = pair.publicKey.export({ format: 'jwk' });
	const kid = crypto.createHash('sha256').update(canonicalJson({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x })).digest('base64url');
	const digest = `sha256:${'b'.repeat(64)}`;
	const manifestDigest = `sha256:${'c'.repeat(64)}`;
	const encodedHeader = Buffer.from(canonicalJson({ alg: 'EdDSA', kid, typ: 'privos-marketplace-image-release+jws' })).toString('base64url');
	const encodedPayload = Buffer.from(canonicalJson({
		type: 'marketplace-image-release',
		aud: 'privos-apps-master',
		releaseId: 'version-1',
		listingId: 'listing-1',
		imageDigest: digest,
		manifestDigest,
	})).toString('base64url');
	const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`);
	const compact = `${encodedHeader}.${encodedPayload}.${crypto.sign(null, signingInput, privateKey).toString('base64url')}`;
	assert.deepEqual(verifyMarketplaceReleaseAttestation({
		compact,
		trustedJwks: [{ ...publicJwk, kid }],
		listingId: 'listing-1',
		imageDigest: digest,
		manifestDigest,
	}), { releaseId: 'version-1', kid });
	assert.throws(() => verifyMarketplaceReleaseAttestation({
		compact,
		trustedJwks: [{ ...publicJwk, kid }],
		listingId: 'listing-2',
		imageDigest: digest,
		manifestDigest,
	}), /release_attestation_binding_mismatch/);
});

test('deployment grants verify against the enrolled key for the exact workspace', async () => {
	const clusterId = 'privos-app-cluster';
	const state = repositories(['workspace-a', 'workspace-b']);
	const verifier = new McpSecurityVerifier(state.repositories, clusterId);
	const first = identity();
	const second = identity();
	for (const [workspaceId, key] of [['workspace-a', first], ['workspace-b', second]] as const) {
		await verifier.enrollHubIdentity({
			workspaceId,
			publicJwk: key.publicJwk,
			compact: enrollmentProof({ clusterId, workspaceId, key }),
		});
	}
	const compact = deploymentGrant({ clusterId, workspaceId: 'workspace-a', key: first });
	assert.equal((await verifier.consumeDeploymentGrant(compact, 'workspace-a')).workspaceId, 'workspace-a');
	await assert.rejects(verifier.consumeDeploymentGrant(compact, 'workspace-b'), /artifact_signature_invalid/);
});

test('enrollment proof is possession-bound and cannot cross workspace affinity', async () => {
	const clusterId = 'privos-app-cluster';
	const state = repositories(['workspace-a', 'workspace-b']);
	const verifier = new McpSecurityVerifier(state.repositories, clusterId);
	const key = identity();
	await assert.rejects(
		verifier.enrollHubIdentity({
			workspaceId: 'workspace-b',
			publicJwk: key.publicJwk,
			compact: enrollmentProof({ clusterId, workspaceId: 'workspace-a', key }),
		}),
		/hub_identity_enrollment_binding_mismatch/,
	);
});

test('enrollment accepts a deployment identity distinct from the authenticated workspace', async () => {
	const clusterId = 'privos-app-cluster';
	const state = repositories(['workspace-a']);
	const verifier = new McpSecurityVerifier(state.repositories, clusterId);
	const key = identity();
	const result = await verifier.enrollHubIdentity({
		workspaceId: 'workspace-a',
		publicJwk: key.publicJwk,
		compact: enrollmentProof({ clusterId, workspaceId: 'workspace-a', deploymentId: 'deployment-a', key }),
	});
	assert.equal(result.hubKid, key.kid);
});

test('lifecycle command consumption is durable, idempotent for exact redelivery, and rejects nonce replay', async () => {
	const clusterId = 'privos-app-cluster';
	const workspaceId = 'workspace-a';
	const state = repositories([workspaceId]);
	const verifier = new McpSecurityVerifier(state.repositories, clusterId);
	const key = identity();
	await verifier.enrollHubIdentity({
		workspaceId,
		publicJwk: key.publicJwk,
		compact: enrollmentProof({ clusterId, workspaceId, deploymentId: 'deployment-1', key }),
	});
	const inventory = buildRuntimeResourceInventoryV3({
		inventoryId: 'inventory-1',
		affinity: {
			clusterId,
			workspaceId,
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 1,
			runtimeInstallationId: 'runtime-1',
			clusterAppId: 'cluster-app-1',
			manifestDigest: `sha256:${'a'.repeat(64)}`,
			resourceManifestHash: 'r'.repeat(43),
		},
		expectedResources: [{
			kind: 'CONTAINER',
			resourceId: 'container-1',
			ownershipScope: 'INSTALLATION_GENERATION',
			nodeId: 'node-1',
			replicaId: '11111111-1111-4111-8111-111111111111',
			attributes: { nodeIdentityKid: 'node-identity-kid-1' },
		}],
		createdAt: new Date(),
	});
	state.runtimeInventories.push(inventory);
	const expected = {
		deploymentId: 'deployment-1',
		generationId: 'generation-1',
		generationNumber: 1,
		runtimeInstallationId: 'runtime-1',
		resourceManifestHash: 'r'.repeat(43),
		runtimeResourceInventoryHash: inventory.runtimeResourceInventoryHash,
		issuer: 'urn:privos:hub:deployment-1',
	};
	const nonce = 'replay-safe-nonce-123456';
	const compact = lifecycleCommand({
		clusterId,
		workspaceId,
		key,
		nonce,
		runtimeResourceInventoryHash: inventory.runtimeResourceInventoryHash,
	});
	const first = await verifier.consumeLifecycleCommandV3({ compact, workspaceId, expected });
	const duplicate = await verifier.consumeLifecycleCommandV3({ compact, workspaceId, expected });
	assert.equal(duplicate.jti, first.jti);
	await assert.rejects(
		verifier.consumeLifecycleCommandV3({
			compact: lifecycleCommand({
				clusterId,
				workspaceId,
				key,
				nonce,
				runtimeResourceInventoryHash: inventory.runtimeResourceInventoryHash,
			}),
			workspaceId,
			expected,
		}),
		(error: unknown) => (error as { code?: string }).code === 'ARTIFACT_REPLAYED',
	);
	await assert.rejects(
		verifier.consumeLifecycleCommandV3({
			compact: lifecycleCommand({
				clusterId,
				workspaceId,
				key,
				runtimeResourceInventoryHash: inventory.runtimeResourceInventoryHash,
				expectedResourceCount: 2,
			}),
			workspaceId,
			expected,
		}),
		(error: unknown) => (error as { code?: string }).code === 'RESOURCE_INVENTORY_COUNT_MISMATCH',
	);
	inventory.expectedResources = inventory.expectedResources.map((resource) => ({
		...resource,
		resourceId: resource.kind === 'CONTAINER' ? 'container-tampered' : resource.resourceId,
	}));
	await assert.rejects(
		verifier.consumeLifecycleCommandV3({
			compact: lifecycleCommand({
				clusterId,
				workspaceId,
				key,
				runtimeResourceInventoryHash: expected.runtimeResourceInventoryHash,
			}),
			workspaceId,
			expected,
		}),
		(error: unknown) => (error as { code?: string }).code === 'RUNTIME_RESOURCE_INVENTORY_HASH_MISMATCH',
	);
});

test('v3 deployment grants require fresh generation identity and allow only exact lost-response retry', async () => {
	const clusterId = 'privos-app-cluster';
	const workspaceId = 'workspace-a';
	const state = repositories([workspaceId]);
	const verifier = new McpSecurityVerifier(state.repositories, clusterId);
	const key = identity();
	await verifier.enrollHubIdentity({
		workspaceId,
		publicJwk: key.publicJwk,
		compact: enrollmentProof({ clusterId, workspaceId, deploymentId: 'deployment-1', key }),
	});
	const previousGeneration = {
		generationId: 'generation-1',
		generationNumber: 1,
		runtimeInstallationId: 'runtime-1',
	};
	const expected = {
		deploymentId: 'deployment-1',
		generationId: 'generation-2',
		generationNumber: 2,
		runtimeInstallationId: 'runtime-2',
		resourceManifestHash: 'r'.repeat(43),
		issuer: 'urn:privos:hub:deployment-1',
		previousGeneration,
	};
	const grantJti = crypto.randomUUID();
	const grantNonce = crypto.randomBytes(24).toString('base64url');
	const issuedAt = Math.floor(Date.now() / 1000);
	const fresh = deploymentGrantV3({
		clusterId,
		workspaceId,
		key,
		generationId: 'generation-2',
		generationNumber: 2,
		runtimeInstallationId: 'runtime-2',
		jti: grantJti,
		nonce: grantNonce,
		issuedAt,
	});
	const accepted = await verifier.consumeDeploymentGrantV3({ compact: fresh, workspaceId, expected });
	const lostResponseRetry = await verifier.consumeDeploymentGrantV3({ compact: fresh, workspaceId, expected });
	assert.equal(accepted.generationNumber, 2);
	assert.equal(lostResponseRetry.jti, accepted.jti);
	await assert.rejects(
		verifier.consumeDeploymentGrantV3({
			compact: deploymentGrantV3({
				clusterId,
				workspaceId,
				key,
				generationId: 'generation-2',
				generationNumber: 2,
				runtimeInstallationId: 'runtime-2',
				jti: crypto.randomUUID(),
				nonce: crypto.randomBytes(24).toString('base64url'),
				issuedAt,
			}),
			workspaceId,
			expected,
		}),
		(error: unknown) => (error as { code?: string }).code === 'ARTIFACT_REPLAYED',
	);
	assert.equal(Object.hasOwn(accepted.deployment, 'runtimeResourceInventoryHash'), false);
	const stored = state.v3Artifacts.get(`deployment-grant:${grantJti}`);
	assert.match(stored?.canonicalPayloadHash, /^[A-Za-z0-9_-]{43}$/);
	assert.match(stored?.compactArtifactHash, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(Object.hasOwn(stored, 'runtimeResourceInventoryHash'), false);

	const resignedSameClaims = deploymentGrantV3({
		clusterId,
		workspaceId,
		key,
		generationId: 'generation-2',
		generationNumber: 2,
		runtimeInstallationId: 'runtime-2',
		jti: grantJti,
		nonce: grantNonce,
		issuedAt,
	});
	assert.notEqual(resignedSameClaims, fresh);
	await assert.rejects(
		verifier.consumeDeploymentGrantV3({ compact: resignedSameClaims, workspaceId, expected }),
		(error: unknown) => (error as { code?: string }).code === 'ARTIFACT_REPLAYED',
	);
	await assert.rejects(
		verifier.consumeDeploymentGrantV3({
			compact: deploymentGrantV3({
				clusterId,
				workspaceId,
				key,
				generationId: 'generation-2',
				generationNumber: 2,
				runtimeInstallationId: 'runtime-2',
				jti: crypto.randomUUID(),
				nonce: grantNonce,
				issuedAt,
			}),
			workspaceId,
			expected,
		}),
		(error: unknown) => (error as { code?: string }).code === 'ARTIFACT_REPLAYED',
	);
	await assert.rejects(
		verifier.consumeDeploymentGrantV3({
			compact: deploymentGrantV3({
				clusterId,
				workspaceId,
				key,
				generationId: 'generation-2',
				generationNumber: 2,
				runtimeInstallationId: 'runtime-2',
				jti: grantJti,
				nonce: crypto.randomBytes(24).toString('base64url'),
				issuedAt,
			}),
			workspaceId,
			expected,
		}),
		(error: unknown) => (error as { code?: string }).code === 'ARTIFACT_REPLAYED',
	);
	await assert.rejects(
		verifier.consumeDeploymentGrantV3({
			compact: deploymentGrantV3({
				clusterId,
				workspaceId,
				key,
				generationId: 'generation-1',
				generationNumber: 1,
				runtimeInstallationId: 'runtime-1',
			}),
			workspaceId,
			expected: {
				...expected,
				generationId: 'generation-1',
				generationNumber: 1,
				runtimeInstallationId: 'runtime-1',
			},
		}),
		(error: unknown) => (error as { code?: string }).code === 'GENERATION_IDENTITY_REUSED',
	);
});

test('v3 dispatch binds the runtime parent, exact room child, stored grant epoch, and one-time delivery', async () => {
	const clusterId = 'privos-app-cluster';
	const workspaceId = 'workspace-a';
	const state = repositories([workspaceId]);
	const verifier = new McpSecurityVerifier(state.repositories, clusterId);
	const key = identity();
	await verifier.enrollHubIdentity({
		workspaceId,
		publicJwk: key.publicJwk,
		compact: enrollmentProof({ clusterId, workspaceId, deploymentId: 'deployment-1', key }),
	});
	const rpc = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'read' }, id: 1 };
	const expected = {
		deploymentId: 'deployment-1',
		generationId: 'generation-1',
		generationNumber: 1,
		runtimeInstallationId: 'runtime-1',
		resourceManifestHash: 'r'.repeat(43),
		runtimeResourceInventoryHash: 'i'.repeat(43),
		issuer: 'urn:privos:hub:deployment-1',
		manifestDigest: `sha256:${'f'.repeat(64)}`,
		runtimeApprovalReceiptHash: 'b'.repeat(43),
		runtimeGrantEpoch: 7,
		mcpAppId: 'mcp-app-1',
		clusterAppId: 'cluster-app-1',
	};
	const workspaceCompact = dispatchAssertionV3({
		clusterId, workspaceId, key, rpc, authorizationContext: 'workspace',
	});
	const workspacePayload = await verifier.consumeDispatchAssertionV3({
		compact: workspaceCompact,
		rpc,
		workspaceId,
		expected,
		authorization: { authorizationContext: 'workspace', runtimeInstallationId: 'runtime-1' },
	});
	assert.equal(workspacePayload.authorizationContext, 'workspace');
	await assert.rejects(
		verifier.consumeDispatchAssertionV3({
			compact: workspaceCompact, rpc, workspaceId, expected,
			authorization: { authorizationContext: 'workspace', runtimeInstallationId: 'runtime-1' },
		}),
		(error: unknown) => (error as { code?: string }).code === 'ARTIFACT_REPLAYED',
	);

	const roomCompact = dispatchAssertionV3({
		clusterId, workspaceId, key, rpc, authorizationContext: 'room',
	});
	await assert.rejects(
		verifier.consumeDispatchAssertionV3({
			compact: roomCompact, rpc, workspaceId, expected,
			authorization: { authorizationContext: 'workspace', runtimeInstallationId: 'runtime-1' },
		}),
		(error: unknown) => (error as { code?: string }).code === 'ROOM_BINDING_REQUIRED',
	);
	await assert.rejects(
		verifier.consumeDispatchAssertionV3({
			compact: roomCompact, rpc, workspaceId, expected,
			authorization: {
				authorizationContext: 'room', runtimeInstallationId: 'runtime-1', authorizationBindingId: 'binding-wrong',
			},
		}),
		(error: unknown) => (error as { code?: string }).code === 'ROOM_BINDING_MISMATCH',
	);
	await assert.rejects(
		verifier.consumeDispatchAssertionV3({
			compact: roomCompact, rpc, workspaceId, expected,
			authorization: {
				authorizationContext: 'room', runtimeInstallationId: 'runtime-wrong', authorizationBindingId: 'binding-1',
			},
		}),
		(error: unknown) => (error as { code?: string }).code === 'GENERATION_AFFINITY_MISMATCH',
	);
	const roomPayload = await verifier.consumeDispatchAssertionV3({
		compact: roomCompact, rpc, workspaceId, expected,
		authorization: {
			authorizationContext: 'room', runtimeInstallationId: 'runtime-1', authorizationBindingId: 'binding-1',
		},
	});
	assert.equal(roomPayload.authorizationContext, 'room');

	await assert.rejects(
		verifier.consumeDispatchAssertionV3({
			compact: dispatchAssertionV3({
				clusterId, workspaceId, key, rpc, authorizationContext: 'workspace', runtimeGrantEpoch: 8,
			}),
			rpc, workspaceId, expected,
			authorization: { authorizationContext: 'workspace', runtimeInstallationId: 'runtime-1' },
		}),
		(error: unknown) => (error as { code?: string }).code === 'GENERATION_AFFINITY_MISMATCH',
	);
});

// roxane-dev HRM 1.2.6 (2026-09-22): another app on the same Hub deployment sat
// at generation 7, and the previous-generation lookup — keyed on the deployment
// alone — refused HRM's fresh generation 4 as GENERATION_IDENTITY_REUSED.
test('v3 provisioning grants compare against the previous generation of the SAME app only', async () => {
	const clusterId = 'privos-app-cluster';
	const workspaceId = 'workspace-a';
	const state = repositories([workspaceId]);
	const rows = [
		{ workspaceId, kind: 'mcp-v3', mcpDeploymentId: 'deployment-1', appId: 'cluster-app-other', mcpGenerationId: 'generation-other', mcpGenerationNumber: 7, mcpRuntimeInstallationId: 'runtime-other' },
		{ workspaceId, kind: 'mcp-v3', mcpDeploymentId: 'deployment-1', appId: 'cluster-app-1', mcpGenerationId: 'generation-1', mcpGenerationNumber: 1, mcpRuntimeInstallationId: 'runtime-1' },
	];
	(state.repositories.apps as any).findOne = async (filter: Record<string, any>) => {
		const matches = rows.filter((row) =>
			Object.entries(filter).every(([field, expected]) => {
				const value = (row as Record<string, unknown>)[field];
				return expected && typeof expected === 'object' && '$ne' in expected ? value !== expected.$ne : value === expected;
			}),
		);
		return matches.sort((a, b) => b.mcpGenerationNumber - a.mcpGenerationNumber)[0] ?? null;
	};
	const verifier = new McpSecurityVerifier(state.repositories, clusterId);
	const key = identity();
	await verifier.enrollHubIdentity({
		workspaceId,
		publicJwk: key.publicJwk,
		compact: enrollmentProof({ clusterId, workspaceId, deploymentId: 'deployment-1', key }),
	});

	const accepted = await verifier.consumeProvisioningDeploymentGrantV3({
		compact: deploymentGrantV3({ clusterId, workspaceId, key, generationId: 'generation-2', generationNumber: 2, runtimeInstallationId: 'runtime-2' }),
		workspaceId,
	});
	assert.equal(accepted.generationNumber, 2);

	await assert.rejects(
		verifier.consumeProvisioningDeploymentGrantV3({
			compact: deploymentGrantV3({ clusterId, workspaceId, key, generationId: 'generation-0', generationNumber: 1, runtimeInstallationId: 'runtime-0' }),
			workspaceId,
		}),
		(error: unknown) => (error as { code?: string }).code === 'GENERATION_IDENTITY_REUSED',
	);
});
