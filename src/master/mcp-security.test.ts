import assert from 'node:assert/strict';
import crypto, { type JsonWebKey } from 'node:crypto';
import test from 'node:test';

import { canonicalJson, jwkThumbprint, signEs256Jws } from '../security/artifacts.js';
import { McpSecurityVerifier, verifyMarketplaceReleaseAttestation } from './mcp-security.js';
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
	return {
		rows,
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
		} as any,
	};
}

function enrollmentProof(input: { clusterId: string; workspaceId: string; key: ReturnType<typeof identity> }): string {
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
			deploymentId: input.workspaceId,
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
