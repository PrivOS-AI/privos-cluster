import crypto from 'node:crypto';
import { z } from 'zod';
import type { JsonWebKey } from 'node:crypto';

import {
	assertArtifactTime,
	canonicalJson,
	jwkThumbprint,
	parseJws,
	sha256,
	sha256Base64Url,
	verifyEs256Jws,
} from '../security/artifacts.js';
import type { MasterRepositories } from './repositories.js';
import {
	McpProtocolV3Error,
	McpDeploymentGrantPayloadV3Schema,
	parseDispatchAssertionPayloadV3,
	verifyDeploymentGrantV3,
	verifyDispatchAssertionV3,
	verifyLifecycleCommandV3,
	type ClusterLifecycleCommandPayloadV3,
	type DeploymentGrantAffinityV3,
	type GenerationAffinityV3,
	type McpDeploymentGrantPayloadV3,
	type McpDispatchAssertionPayloadV3,
} from './protocol-v3.js';
import { runtimeResourceInventoryHashV3 } from './runtime-resource-inventory.js';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const HubIdentityEnrollmentPayloadSchema = z.object({
	type: z.literal('mcp-hub-identity-enrollment'),
	aud: z.literal('privos-apps-master'),
	jti: z.string().uuid(),
	iat: z.number().int(),
	exp: z.number().int(),
	clusterId: z.string().min(1),
	workspaceId: z.string().min(1),
	deploymentId: z.string().min(1),
	kid: z.string().min(20),
}).strict();
const Resources = z.object({
	memoryMb: z.number().int().min(64).max(16384),
	cpus: z.number().min(0.1).max(16),
	tmpSizeMb: z.number().int().min(16).max(4096).default(64),
}).strict();

export const McpDeploymentGrantPayloadSchema = z.object({
	type: z.literal('mcp-deployment-grant'),
	aud: z.literal('privos-apps-master'),
	jti: z.string().uuid(),
	iat: z.number().int(),
	exp: z.number().int(),
	clusterId: z.string().min(1),
	workspaceId: z.string().min(1),
	installationId: z.string().min(1),
	mcpAppId: z.string().min(1),
	receiptHash: Digest,
	grantEpoch: z.number().int().positive(),
	hubOrigin: z.string().url().refine((value) => new URL(value).protocol === 'https:'),
	deployment: z.object({
		appId: z.string().min(1).max(128),
		listingId: z.string().min(1).max(128),
		versionDigest: Digest,
		image: z.string().min(1),
		imageDigest: Digest,
		manifestDigest: Digest,
		port: z.number().int().min(1).max(65535).default(3001),
		resources: Resources,
		envVars: z.record(z.string(), z.string()).default({}),
		volumes: z.array(z.object({
			name: z.literal('data'),
			mountPath: z.string().startsWith('/'),
			sizeMb: z.number().int().positive().optional(),
		}).strict()).max(1).default([]),
		availabilityTier: z.enum(['single', 'ha']).default('single'),
		stateless: z.boolean().default(false),
		releaseAttestationJws: z.string().min(32),
		subdomain: z.string().nullable().optional(),
		domain: z.string().nullable().optional(),
	}).strict(),
}).strict();

export type McpDeploymentGrantPayload = z.infer<typeof McpDeploymentGrantPayloadSchema>;

const DispatchAssertionPayloadSchema = z.object({
	type: z.literal('hub-dispatch-assertion'),
	aud: z.literal('privos-mcp-app'),
	jti: z.string().uuid(),
	iat: z.number().int(),
	exp: z.number().int(),
	workspaceId: z.string().min(1),
	installationId: z.string().min(1),
	mcpAppId: z.string().min(1),
	clusterAppId: z.string().uuid(),
	replicaId: z.string().uuid(),
	htm: z.literal('POST'),
	htu: z.literal('/mcp'),
	bodyDigest: Digest,
	receiptHash: Digest,
	grantEpoch: z.number().int().positive(),
}).strict();

export type DispatchAssertionPayload = z.infer<typeof DispatchAssertionPayloadSchema>;

const MarketplaceReleasePayloadSchema = z.object({
	type: z.literal('marketplace-image-release'),
	aud: z.literal('privos-apps-master'),
	releaseId: z.string().min(1),
	listingId: z.string().min(1),
	imageDigest: Digest,
	manifestDigest: Digest,
}).strict();

export function verifyMarketplaceReleaseAttestation(input: {
	compact: string;
	trustedJwks: JsonWebKey[];
	listingId: string;
	imageDigest: string;
	manifestDigest: string;
}): { releaseId: string; kid: string } {
	const parsed = parseJws(input.compact);
	if (parsed.header.typ !== 'privos-marketplace-image-release+jws' || typeof parsed.header.kid !== 'string') {
		throw new Error('release_authority_key_untrusted');
	}
	let matched: { jwk: JsonWebKey; kid: string } | undefined;
	for (const jwk of input.trustedJwks) {
		try {
			const kid = typeof jwk.kid === 'string' && jwk.kid
				? jwk.kid
				: jwk.kty === 'EC' ? jwkThumbprint(jwk) : '';
			if (parsed.header.kid === kid) matched = { jwk, kid };
		} catch {
			// Ignore malformed trust entries; a matching valid key is mandatory.
		}
	}
	if (!matched) throw new Error('release_authority_key_untrusted');
	let signatureValid = false;
	try {
		const key = crypto.createPublicKey({ key: matched.jwk, format: 'jwk' });
		if (parsed.header.alg === 'EdDSA' && matched.jwk.kty === 'OKP' && matched.jwk.crv === 'Ed25519') {
			signatureValid = crypto.verify(null, parsed.signingInput, key, parsed.signature);
		} else if (parsed.header.alg === 'ES256' && matched.jwk.kty === 'EC' && matched.jwk.crv === 'P-256') {
			signatureValid = crypto.verify('sha256', parsed.signingInput, { key, dsaEncoding: 'ieee-p1363' }, parsed.signature);
		}
	} catch {
		throw new Error('release_attestation_signature_invalid');
	}
	if (!signatureValid) throw new Error('release_attestation_signature_invalid');
	const payload = MarketplaceReleasePayloadSchema.parse(parsed.payload);
	if (
		payload.listingId !== input.listingId ||
		payload.imageDigest !== input.imageDigest ||
		payload.manifestDigest !== input.manifestDigest
	) throw new Error('release_attestation_binding_mismatch');
	return { releaseId: payload.releaseId, kid: matched.kid };
}

export class McpSecurityVerifier {
	constructor(
		private readonly repositories: MasterRepositories,
		private readonly clusterId: string,
	) {}

	async publicInfo(workspaceId: string): Promise<{ kid: string; publicJwk: JsonWebKey } | null> {
		const workspace = await this.repositories.workspaces.findOne({ workspaceId, status: 'ACTIVE' });
		if (!workspace?.mcpHubIdentityKid || !workspace.mcpHubIdentityPublicJwk) return null;
		if (jwkThumbprint(workspace.mcpHubIdentityPublicJwk) !== workspace.mcpHubIdentityKid) {
			throw new Error('hub_identity_record_invalid');
		}
		return { kid: workspace.mcpHubIdentityKid, publicJwk: workspace.mcpHubIdentityPublicJwk };
	}

	clusterIdentity(): string {
		return this.clusterId;
	}

	async enrollHubIdentity(input: {
		compact: string;
		publicJwk: JsonWebKey;
		workspaceId: string;
	}): Promise<{ clusterId: string; hubKid: string }> {
		const kid = jwkThumbprint(input.publicJwk);
		const parsed = verifyEs256Jws({
			compact: input.compact,
			publicJwk: input.publicJwk,
			kid,
			typ: 'privos-hub-identity-enrollment+jws',
		});
		const payload = HubIdentityEnrollmentPayloadSchema.parse(parsed.payload);
		assertArtifactTime(payload, 120);
		if (
			payload.clusterId !== this.clusterId ||
			payload.workspaceId !== input.workspaceId ||
			payload.kid !== kid
		) {
			throw new Error('hub_identity_enrollment_binding_mismatch');
		}
		const existing = await this.repositories.workspaces.findOne({ workspaceId: input.workspaceId, status: 'ACTIVE' });
		if (!existing) throw new Error('hub_workspace_not_active');
		if (existing.mcpHubIdentityKid || existing.mcpHubIdentityPublicJwk) {
			if (
				existing.mcpHubIdentityKid === kid &&
				existing.mcpHubIdentityPublicJwk &&
				canonicalJson(existing.mcpHubIdentityPublicJwk) === canonicalJson(input.publicJwk)
			) return { clusterId: this.clusterId, hubKid: kid };
			throw new Error('hub_identity_conflict');
		}
		const enrolledAt = new Date();
		const updated = await this.repositories.workspaces.updateOne(
			{
				workspaceId: input.workspaceId,
				status: 'ACTIVE',
				mcpHubIdentityKid: { $exists: false },
				mcpHubIdentityPublicJwk: { $exists: false },
			},
			{
				$set: {
					mcpHubIdentityKid: kid,
					mcpHubIdentityPublicJwk: input.publicJwk,
					mcpHubIdentityEnrolledAt: enrolledAt,
					updatedAt: enrolledAt,
				},
			},
		);
		if (updated.matchedCount !== 1) {
			const raced = await this.publicInfo(input.workspaceId);
			if (raced?.kid === kid && canonicalJson(raced.publicJwk) === canonicalJson(input.publicJwk)) {
				return { clusterId: this.clusterId, hubKid: kid };
			}
			throw new Error('hub_identity_conflict');
		}
		return { clusterId: this.clusterId, hubKid: kid };
	}

	async consumeDeploymentGrant(compact: string, workspaceId: string): Promise<McpDeploymentGrantPayload> {
		const identity = await this.requirePublicInfo(workspaceId);
		const parsed = verifyEs256Jws({
			compact,
			publicJwk: identity.publicJwk,
			kid: identity.kid,
			typ: 'privos-deployment-grant+jws',
		});
		const payload = McpDeploymentGrantPayloadSchema.parse(parsed.payload);
		assertArtifactTime(payload, 120);
		if (payload.clusterId !== this.clusterId || payload.workspaceId !== workspaceId) {
			throw new Error('deployment_grant_binding_mismatch');
		}
		if (Object.keys(payload.deployment.envVars).some((key) => key.toUpperCase().startsWith('PRIVOS_'))) {
			throw new Error('reserved_environment_override');
		}
		await this.consume('deployment-grant', payload.jti, payload.workspaceId, payload.installationId, payload.exp);
		return payload;
	}

	async consumeDispatchAssertion(input: {
		compact: string;
		workspaceId: string;
		installationId: string;
		clusterAppId: string;
		replicaId: string;
		rpc: unknown;
	}): Promise<DispatchAssertionPayload> {
		const identity = await this.requirePublicInfo(input.workspaceId);
		const parsed = verifyEs256Jws({
			compact: input.compact,
			publicJwk: identity.publicJwk,
			kid: identity.kid,
			typ: 'privos-hub-dispatch+jws',
		});
		const payload = DispatchAssertionPayloadSchema.parse(parsed.payload);
		assertArtifactTime(payload, 30);
		if (
			payload.workspaceId !== input.workspaceId ||
			payload.installationId !== input.installationId ||
			payload.clusterAppId !== input.clusterAppId ||
			payload.replicaId !== input.replicaId ||
			payload.bodyDigest !== sha256(canonicalJson(input.rpc))
		) {
			throw new Error('dispatch_assertion_binding_mismatch');
		}
		await this.consume('dispatch-assertion', payload.jti, payload.workspaceId, payload.installationId, payload.exp);
		return payload;
	}

	/**
	 * Consume a Hub grant for a fresh immutable generation. An exact compact
	 * redelivery is an idempotent transport retry; any changed signed bytes,
	 * JTI, nonce, or generation affinity remain a replay failure.
	 */
	async consumeDeploymentGrantV3(input: {
		compact: string;
		workspaceId: string;
		expected: Omit<DeploymentGrantAffinityV3, 'clusterId' | 'workspaceId'>;
	}): Promise<McpDeploymentGrantPayloadV3> {
		const identity = await this.requirePublicInfo(input.workspaceId);
		const payload = verifyDeploymentGrantV3({
			compact: input.compact,
			publicJwk: identity.publicJwk,
			kid: identity.kid,
			expected: {
				...input.expected,
				clusterId: this.clusterId,
				workspaceId: input.workspaceId,
			},
		});
		if (Object.keys(payload.deployment.envVars).some((key) => key.toUpperCase().startsWith('PRIVOS_'))) {
			throw new McpProtocolV3Error('PROTOCOL_ENVELOPE_INVALID');
		}
		const canonicalPayloadHash = sha256Base64Url(canonicalJson(payload));
		const compactArtifactHash = sha256Base64Url(input.compact);
		const record = {
			_id: `deployment-grant:${payload.jti}`,
			protocolVersion: 3 as const,
			kind: 'deployment-grant' as const,
			jti: payload.jti,
			nonce: payload.nonce,
			clusterId: payload.clusterId,
			workspaceId: payload.workspaceId,
			deploymentId: payload.deploymentId,
			generationId: payload.generationId,
			generationNumber: payload.generationNumber,
			runtimeInstallationId: payload.runtimeInstallationId,
			resourceManifestHash: payload.deployment.resourceManifestHash,
			issuer: payload.iss,
			canonicalPayloadHash,
			compactArtifactHash,
			expiresAt: new Date(payload.exp * 1000),
			createdAt: new Date(),
		};
		try {
			await this.repositories.mcpProtocolV3ArtifactUses.insertOne(record);
		} catch (error: unknown) {
			if ((error as { code?: number }).code !== 11000) throw error;
			const consumed = await this.repositories.mcpProtocolV3ArtifactUses.findOne({
				kind: 'deployment-grant',
				$or: [{ _id: record._id }, { nonce: record.nonce }],
			});
			if (
				consumed?.canonicalPayloadHash === canonicalPayloadHash &&
				consumed.compactArtifactHash === compactArtifactHash &&
				consumed.jti === payload.jti &&
				consumed.nonce === payload.nonce &&
				consumed.clusterId === payload.clusterId &&
				consumed.workspaceId === payload.workspaceId &&
				consumed.deploymentId === payload.deploymentId &&
				consumed.generationId === payload.generationId &&
				consumed.generationNumber === payload.generationNumber &&
				consumed.runtimeInstallationId === payload.runtimeInstallationId &&
				consumed.resourceManifestHash === payload.deployment.resourceManifestHash &&
				consumed.issuer === payload.iss
			) return payload;
			throw new McpProtocolV3Error('ARTIFACT_REPLAYED');
		}
		return payload;
	}

	async consumeProvisioningDeploymentGrantV3(input: {
		compact: string;
		workspaceId: string;
		previousGeneration?: DeploymentGrantAffinityV3['previousGeneration'];
	}): Promise<McpDeploymentGrantPayloadV3> {
		let unverified: McpDeploymentGrantPayloadV3;
		try {
			unverified = McpDeploymentGrantPayloadV3Schema.parse(parseJws(input.compact).payload);
		} catch {
			throw new McpProtocolV3Error('PROTOCOL_ENVELOPE_INVALID');
		}
		let previousGeneration = input.previousGeneration;
		if (!previousGeneration) {
			const previous = await this.repositories.apps.findOne({
				workspaceId: input.workspaceId,
				kind: 'mcp-v3',
				mcpDeploymentId: unverified.deploymentId,
				mcpGenerationId: { $ne: unverified.generationId },
			}, { sort: { mcpGenerationNumber: -1 } });
			if (
				previous?.mcpGenerationId &&
				previous.mcpGenerationNumber &&
				previous.mcpRuntimeInstallationId
			) {
				previousGeneration = {
					generationId: previous.mcpGenerationId,
					generationNumber: previous.mcpGenerationNumber,
					runtimeInstallationId: previous.mcpRuntimeInstallationId,
				};
			}
		}
		return this.consumeDeploymentGrantV3({
			compact: input.compact,
			workspaceId: input.workspaceId,
			expected: {
				deploymentId: unverified.deploymentId,
				generationId: unverified.generationId,
				generationNumber: unverified.generationNumber,
				runtimeInstallationId: unverified.runtimeInstallationId,
				resourceManifestHash: unverified.deployment.resourceManifestHash,
				issuer: `urn:privos:hub:${unverified.deploymentId}`,
				previousGeneration,
			},
		});
	}

	async consumeDispatchAssertionV3(input: {
		compact: string;
		rpc: unknown;
		workspaceId: string;
		expected: Omit<GenerationAffinityV3, 'clusterId' | 'workspaceId'> & {
			issuer: string;
			manifestDigest: string;
			runtimeApprovalReceiptHash: string;
			runtimeGrantEpoch: number;
			mcpAppId: string;
			clusterAppId: string;
		};
		authorization: {
			authorizationContext: 'workspace';
			runtimeInstallationId: string;
		} | {
			authorizationContext: 'room';
			runtimeInstallationId: string;
			authorizationBindingId: string;
		};
	}): Promise<McpDispatchAssertionPayloadV3> {
		const identity = await this.requirePublicInfo(input.workspaceId);
		let unverified: McpDispatchAssertionPayloadV3;
		try {
			unverified = parseDispatchAssertionPayloadV3(parseJws(input.compact).payload);
		} catch (error) {
			if (error instanceof McpProtocolV3Error) throw error;
			throw new McpProtocolV3Error('PROTOCOL_ENVELOPE_INVALID');
		}
		if (
			input.authorization.runtimeInstallationId !== input.expected.runtimeInstallationId ||
			unverified.mcpAppId !== input.expected.mcpAppId ||
			unverified.clusterAppId !== input.expected.clusterAppId
		) throw new McpProtocolV3Error('GENERATION_AFFINITY_MISMATCH');
		if (
			input.authorization.authorizationContext === 'room' &&
			unverified.authorizationContext !== 'room'
		) throw new McpProtocolV3Error('ROOM_BINDING_REQUIRED');
		const payload = verifyDispatchAssertionV3({
			compact: input.compact,
			publicJwk: identity.publicJwk,
			kid: identity.kid,
			expected: unverified.authorizationContext === 'room' ? {
				...input.expected,
				clusterId: this.clusterId,
				workspaceId: input.workspaceId,
				authorizationContext: 'room',
				roomId: unverified.roomId,
				authorizationBindingId: input.authorization.authorizationContext === 'room'
					? input.authorization.authorizationBindingId
					: undefined,
				bindingReceiptHash: unverified.bindingReceiptHash,
				bindingEpoch: unverified.bindingEpoch,
				bodyDigest: sha256Base64Url(canonicalJson(input.rpc)),
			} : {
				...input.expected,
				clusterId: this.clusterId,
				workspaceId: input.workspaceId,
				authorizationContext: input.authorization.authorizationContext,
				bodyDigest: sha256Base64Url(canonicalJson(input.rpc)),
			},
		});
		if (payload.authorizationContext !== input.authorization.authorizationContext) {
			throw new McpProtocolV3Error(
				input.authorization.authorizationContext === 'room'
					? 'ROOM_BINDING_REQUIRED'
					: 'GENERATION_AFFINITY_MISMATCH',
			);
		}
		const record = {
			_id: `dispatch-assertion:${payload.jti}`,
			protocolVersion: 3 as const,
			kind: 'dispatch-assertion' as const,
			jti: payload.jti,
			nonce: payload.nonce,
			clusterId: payload.clusterId,
			workspaceId: payload.workspaceId,
			deploymentId: payload.deploymentId,
			generationId: payload.generationId,
			generationNumber: payload.generationNumber,
			runtimeInstallationId: payload.runtimeInstallationId,
			resourceManifestHash: payload.resourceManifestHash,
			runtimeResourceInventoryHash: payload.runtimeResourceInventoryHash,
			issuer: payload.iss,
			canonicalPayloadHash: sha256Base64Url(canonicalJson(payload)),
			compactArtifactHash: sha256Base64Url(input.compact),
			expiresAt: new Date(payload.exp * 1000),
			createdAt: new Date(),
		};
		try {
			await this.repositories.mcpProtocolV3ArtifactUses.insertOne(record);
		} catch (error: unknown) {
			if ((error as { code?: number }).code === 11000) {
				throw new McpProtocolV3Error('ARTIFACT_REPLAYED');
			}
			throw error;
		}
		return payload;
	}

	/**
	 * Verify and durably consume a protocol-v3 lifecycle command. An identical
	 * redelivery is idempotent; reuse of either JTI or nonce with different
	 * signed bytes is a replay attack.
	 */
	async consumeLifecycleCommandV3(input: {
		compact: string;
		workspaceId: string;
		expected: Omit<GenerationAffinityV3, 'clusterId' | 'workspaceId'> & { issuer: string };
	}): Promise<ClusterLifecycleCommandPayloadV3> {
		const identity = await this.requirePublicInfo(input.workspaceId);
		const payload = verifyLifecycleCommandV3({
			compact: input.compact,
			publicJwk: identity.publicJwk,
			kid: identity.kid,
			expected: {
				...input.expected,
				clusterId: this.clusterId,
				workspaceId: input.workspaceId,
			},
		});
		const inventory = await this.repositories.runtimeResourceInventories.findOne({
			clusterId: payload.clusterId,
			workspaceId: payload.workspaceId,
			deploymentId: payload.deploymentId,
			generationId: payload.generationId,
			runtimeInstallationId: payload.runtimeInstallationId,
		});
		if (!inventory) throw new McpProtocolV3Error('CLEANUP_REQUIRED');
		if (inventory.state === 'MIGRATION_REVIEW_REQUIRED') {
			throw new McpProtocolV3Error('MIGRATION_REVIEW_REQUIRED');
		}
		if (inventory.state !== 'READY' && inventory.state !== 'COMPACTED') {
			throw new McpProtocolV3Error('CLEANUP_REQUIRED');
		}
		if (inventory.resourceManifestHash !== payload.resourceManifestHash) {
			throw new McpProtocolV3Error('RESOURCE_MANIFEST_HASH_MISMATCH');
		}
		if (inventory.expectedResources.length !== payload.expectedResourceCount) {
			throw new McpProtocolV3Error('RESOURCE_INVENTORY_COUNT_MISMATCH');
		}
		const persistedInventoryHash = runtimeResourceInventoryHashV3({
			clusterId: inventory.clusterId,
			workspaceId: inventory.workspaceId,
			deploymentId: inventory.deploymentId,
			generationId: inventory.generationId,
			generationNumber: inventory.generationNumber,
			runtimeInstallationId: inventory.runtimeInstallationId,
			clusterAppId: inventory.clusterAppId,
			manifestDigest: inventory.manifestDigest,
			resourceManifestHash: inventory.resourceManifestHash,
		}, inventory.expectedResources);
		if (
			persistedInventoryHash !== inventory.runtimeResourceInventoryHash ||
			persistedInventoryHash !== payload.runtimeResourceInventoryHash
		) throw new McpProtocolV3Error('RUNTIME_RESOURCE_INVENTORY_HASH_MISMATCH');
		const canonicalPayloadHash = sha256Base64Url(canonicalJson(payload));
		const compactArtifactHash = sha256Base64Url(input.compact);
		const record = {
			_id: `lifecycle-command:${payload.jti}`,
			protocolVersion: 3 as const,
			kind: 'lifecycle-command' as const,
			jti: payload.jti,
			nonce: payload.nonce,
			clusterId: payload.clusterId,
			workspaceId: payload.workspaceId,
			deploymentId: payload.deploymentId,
			generationId: payload.generationId,
			generationNumber: payload.generationNumber,
			runtimeInstallationId: payload.runtimeInstallationId,
			operationId: payload.operationId,
			resourceManifestHash: payload.resourceManifestHash,
			runtimeResourceInventoryHash: payload.runtimeResourceInventoryHash,
			issuer: payload.iss,
			canonicalPayloadHash,
			compactArtifactHash,
			expiresAt: new Date(payload.exp * 1000),
			createdAt: new Date(),
		};
		try {
			await this.repositories.mcpProtocolV3ArtifactUses.insertOne(record);
		} catch (error: unknown) {
			if ((error as { code?: number }).code !== 11000) throw error;
			const consumed = await this.repositories.mcpProtocolV3ArtifactUses.findOne({
				kind: 'lifecycle-command',
				$or: [{ _id: record._id }, { nonce: record.nonce }],
			});
			if (
				consumed?.canonicalPayloadHash === canonicalPayloadHash &&
				consumed.compactArtifactHash === compactArtifactHash &&
				consumed.jti === payload.jti &&
				consumed.nonce === payload.nonce &&
				consumed.operationId === payload.operationId &&
				consumed.clusterId === payload.clusterId &&
				consumed.workspaceId === payload.workspaceId &&
				consumed.deploymentId === payload.deploymentId &&
				consumed.generationId === payload.generationId &&
				consumed.generationNumber === payload.generationNumber &&
				consumed.runtimeInstallationId === payload.runtimeInstallationId &&
				consumed.resourceManifestHash === payload.resourceManifestHash &&
				consumed.runtimeResourceInventoryHash === payload.runtimeResourceInventoryHash &&
				consumed.issuer === payload.iss
			) return payload;
			throw new McpProtocolV3Error('ARTIFACT_REPLAYED');
		}
		return payload;
	}

	private async requirePublicInfo(workspaceId: string): Promise<{ kid: string; publicJwk: JsonWebKey }> {
		const identity = await this.publicInfo(workspaceId);
		if (!identity) throw new Error('hub_identity_not_enrolled');
		return identity;
	}

	private async consume(
		kind: 'deployment-grant' | 'dispatch-assertion',
		jti: string,
		workspaceId: string,
		installationId: string,
		exp: number,
	): Promise<void> {
		try {
			await this.repositories.mcpArtifactUses.insertOne({
				_id: `${kind}:${jti}`,
				kind,
				workspaceId,
				installationId,
				expiresAt: new Date(exp * 1000),
				createdAt: new Date(),
			});
		} catch (error: unknown) {
			if ((error as { code?: number }).code === 11000) throw new Error(`${kind.replace('-', '_')}_replayed`);
			throw error;
		}
	}
}
