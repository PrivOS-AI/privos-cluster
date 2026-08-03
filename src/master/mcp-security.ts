import crypto from 'node:crypto';
import { z } from 'zod';
import type { JsonWebKey } from 'node:crypto';

import { assertArtifactTime, canonicalJson, jwkThumbprint, parseJws, sha256, verifyEs256Jws } from '../security/artifacts.js';
import type { MasterRepositories } from './repositories.js';

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
