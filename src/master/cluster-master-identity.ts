import crypto, { type JsonWebKey } from 'node:crypto';

import { sha256Base64Url, signEs256Jws } from '../security/artifacts.js';
import {
	generateNodeIdentity,
	validateNodeIdentity,
	type StoredNodeIdentity,
} from '../security/node-identity.js';
import type { MasterRepositories } from './repositories.js';
import { KeyCipher } from './key-crypto.js';
import {
	ClusterFinalAcknowledgementPayloadV3Schema,
	ClusterReconfigureAcknowledgementPayloadV3Schema,
	ClusterRuntimeInventoryAttestationPayloadV3Schema,
	ClusterUpgradeAcknowledgementPayloadV3Schema,
	MCP_PROTOCOL_V3,
	verifyClusterRuntimeInventoryAttestationV3,
	type ClusterFinalAcknowledgementPayloadV3,
	type ClusterReconfigureAcknowledgementPayloadV3,
	type ClusterRuntimeInventoryAttestationPayloadV3,
	type ClusterUpgradeAcknowledgementPayloadV3,
} from '../protocol/protocol-v3.js';
import { runtimeResourceInventoryHashV3 } from './runtime-resource-inventory.js';
import type {
	ClusterSigningIdentityRecord,
	RuntimeInventoryAttestationRecord,
	RuntimeResourceInventory,
} from './types.js';

type IdentityMaterial = {
	record: ClusterSigningIdentityRecord;
	privateJwk: JsonWebKey;
};

type FinalAcknowledgementInput = Omit<
	ClusterFinalAcknowledgementPayloadV3,
	'protocolVersion' | 'type' | 'aud' | 'iss' | 'jti' | 'nonce' | 'iat' | 'exp'
>;

type ReconfigureAcknowledgementInput = Omit<
	ClusterReconfigureAcknowledgementPayloadV3,
	'protocolVersion' | 'type' | 'aud' | 'iss' | 'jti' | 'nonce' | 'iat' | 'exp'
>;

type UpgradeAcknowledgementInput = Omit<
	ClusterUpgradeAcknowledgementPayloadV3,
	'protocolVersion' | 'type' | 'aud' | 'iss' | 'jti' | 'nonce' | 'iat' | 'exp'
>;

/**
 * Mongo-persisted Cluster master evidence identity.
 *
 * The existing APP_MASTER_KEY_ENCRYPTION_KEY encrypts the private JWK at rest,
 * so the identity survives container replacement without adding a host-mounted
 * key file. The public key is safe to expose to an authenticated Hub.
 */
export class ClusterMasterIdentity {
	private loaded?: Promise<IdentityMaterial>;
	private readonly identityId: string;
	private readonly issuer: string;

	constructor(
		private readonly repositories: MasterRepositories,
		private readonly cipher: KeyCipher,
		private readonly clusterId: string,
	) {
		this.identityId = `cluster-master:${clusterId}`;
		this.issuer = `urn:privos:app-cluster:${clusterId}`;
	}

	async publicInfo(): Promise<{
		protocolVersion: 3;
		clusterId: string;
		issuer: string;
		algorithm: 'ES256';
		artifactType: 'privos-cluster-final-cleanup-ack+jws';
		artifactTypes: readonly [
			'privos-cluster-runtime-inventory-attestation+jws',
			'privos-cluster-final-cleanup-ack+jws',
			'privos-cluster-reconfigure-ack+jws',
			'privos-cluster-upgrade-ack+jws',
		];
		kid: string;
		publicJwk: JsonWebKey;
	}> {
		const { record } = await this.load();
		return {
			protocolVersion: MCP_PROTOCOL_V3,
			clusterId: record.clusterId,
			issuer: record.issuer,
			algorithm: record.algorithm,
			artifactType: 'privos-cluster-final-cleanup-ack+jws',
			artifactTypes: [
				'privos-cluster-runtime-inventory-attestation+jws',
				'privos-cluster-final-cleanup-ack+jws',
				'privos-cluster-reconfigure-ack+jws',
				'privos-cluster-upgrade-ack+jws',
			],
			kid: record.kid,
			publicJwk: record.publicJwk,
		};
	}

	async signRuntimeInventoryAttestation(
		input: { deploymentGrantJti: string; inventoryId: string },
		lifetimeSeconds = 300,
	): Promise<{
		payload: ClusterRuntimeInventoryAttestationPayloadV3;
		compact: string;
		artifactHash: string;
		kid: string;
	}> {
		if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 300) {
			throw new Error('cluster_attestation_lifetime_invalid');
		}
		const inventory = await this.repositories.runtimeResourceInventories.findOne({
			inventoryId: input.inventoryId,
			clusterId: this.clusterId,
		});
		if (!inventory || (inventory.state !== 'READY' && !inventory.runtimeInventoryAttestation)) {
			throw new Error('runtime_resource_inventory_not_ready');
		}
		const computedInventoryHash = runtimeResourceInventoryHashV3({
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
		if (computedInventoryHash !== inventory.runtimeResourceInventoryHash) {
			throw new Error('runtime_resource_inventory_invalid');
		}
		const material = await this.load();
		const persistedResult = (
			current: RuntimeResourceInventory,
			attestation: RuntimeInventoryAttestationRecord,
		) => {
			if (attestation.deploymentGrantJti !== input.deploymentGrantJti) {
				throw new Error('runtime_inventory_attestation_conflict');
			}
			if (sha256Base64Url(attestation.compact) !== attestation.artifactHash) {
				throw new Error('runtime_inventory_attestation_invalid');
			}
			const payload = verifyClusterRuntimeInventoryAttestationV3({
				compact: attestation.compact,
				publicJwk: material.record.publicJwk,
				kid: material.record.kid,
				expected: {
					clusterId: current.clusterId,
					workspaceId: current.workspaceId,
					deploymentId: current.deploymentId,
					generationId: current.generationId,
					generationNumber: current.generationNumber,
					runtimeInstallationId: current.runtimeInstallationId,
					resourceManifestHash: current.resourceManifestHash,
					issuer: this.issuer,
					deploymentGrantJti: input.deploymentGrantJti,
					clusterAppId: current.clusterAppId,
					manifestDigest: current.manifestDigest,
					inventoryId: current.inventoryId,
					runtimeResourceInventoryHash: current.runtimeResourceInventoryHash,
					expectedResourceCount: current.expectedResources.length,
				},
			});
			if (payload.jti !== attestation.jti) {
				throw new Error('runtime_inventory_attestation_invalid');
			}
			return {
				payload,
				compact: attestation.compact,
				artifactHash: attestation.artifactHash,
				kid: material.record.kid,
			};
		};
		if (inventory.runtimeInventoryAttestation) {
			return persistedResult(inventory, inventory.runtimeInventoryAttestation);
		}
		const now = Math.floor(Date.now() / 1000);
		const payload = ClusterRuntimeInventoryAttestationPayloadV3Schema.parse({
			protocolVersion: MCP_PROTOCOL_V3,
			type: 'cluster-runtime-inventory-attestation',
			iss: this.issuer,
			aud: 'privos-hub-api',
			jti: crypto.randomUUID(),
			nonce: crypto.randomBytes(24).toString('base64url'),
			iat: now,
			exp: now + lifetimeSeconds,
			deploymentGrantJti: input.deploymentGrantJti,
			inventoryId: inventory.inventoryId,
			clusterId: inventory.clusterId,
			workspaceId: inventory.workspaceId,
			deploymentId: inventory.deploymentId,
			generationId: inventory.generationId,
			generationNumber: inventory.generationNumber,
			runtimeInstallationId: inventory.runtimeInstallationId,
			clusterAppId: inventory.clusterAppId,
			manifestDigest: inventory.manifestDigest,
			resourceManifestHash: inventory.resourceManifestHash,
			runtimeResourceInventoryHash: computedInventoryHash,
			expectedResourceCount: inventory.expectedResources.length,
			persistedAt: inventory.updatedAt.toISOString(),
		});
		const compact = signEs256Jws({
			payload,
			privateJwk: material.privateJwk,
			kid: material.record.kid,
			typ: 'privos-cluster-runtime-inventory-attestation+jws',
			protocolVersion: MCP_PROTOCOL_V3,
		});
		const runtimeInventoryAttestation: RuntimeInventoryAttestationRecord = {
			deploymentGrantJti: input.deploymentGrantJti,
			jti: payload.jti,
			payload,
			compact,
			artifactHash: sha256Base64Url(compact),
			attestedAt: new Date(),
		};
		const persisted = await this.repositories.runtimeResourceInventories.updateOne({
			_id: inventory._id,
			clusterId: this.clusterId,
			state: 'READY',
			runtimeInventoryAttestation: { $exists: false },
		}, { $set: { runtimeInventoryAttestation } });
		if (persisted.matchedCount === 1) {
			return {
				payload,
				compact,
				artifactHash: runtimeInventoryAttestation.artifactHash,
				kid: material.record.kid,
			};
		}
		const concurrent = await this.repositories.runtimeResourceInventories.findOne({
			inventoryId: input.inventoryId,
			clusterId: this.clusterId,
		});
		if (concurrent?.runtimeInventoryAttestation) {
			return persistedResult(concurrent, concurrent.runtimeInventoryAttestation);
		}
		throw new Error('runtime_resource_inventory_not_ready');
	}

	async signFinalAcknowledgement(
		input: FinalAcknowledgementInput,
		lifetimeSeconds = 300,
	): Promise<{
		payload: ClusterFinalAcknowledgementPayloadV3;
		compact: string;
		artifactHash: string;
		kid: string;
	}> {
		if (input.clusterId !== this.clusterId) throw new Error('cluster_acknowledgement_affinity_mismatch');
		if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 300) {
			throw new Error('cluster_acknowledgement_lifetime_invalid');
		}
		const material = await this.load();
		const now = Math.floor(Date.now() / 1000);
		const payload = ClusterFinalAcknowledgementPayloadV3Schema.parse({
			...input,
			protocolVersion: MCP_PROTOCOL_V3,
			type: 'cluster-final-cleanup-acknowledgement',
			iss: this.issuer,
			aud: 'privos-hub-api',
			jti: crypto.randomUUID(),
			nonce: crypto.randomBytes(24).toString('base64url'),
			iat: now,
			exp: now + lifetimeSeconds,
		});
		const compact = signEs256Jws({
			payload,
			privateJwk: material.privateJwk,
			kid: material.record.kid,
			typ: 'privos-cluster-final-cleanup-ack+jws',
			protocolVersion: MCP_PROTOCOL_V3,
		});
		return { payload, compact, artifactHash: sha256Base64Url(compact), kid: material.record.kid };
	}

	async signReconfigureAcknowledgement(
		input: ReconfigureAcknowledgementInput,
		lifetimeSeconds = 300,
	): Promise<{
		payload: ClusterReconfigureAcknowledgementPayloadV3;
		compact: string;
		artifactHash: string;
		kid: string;
	}> {
		if (input.clusterId !== this.clusterId) throw new Error('cluster_acknowledgement_affinity_mismatch');
		if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 300) {
			throw new Error('cluster_acknowledgement_lifetime_invalid');
		}
		const material = await this.load();
		const now = Math.floor(Date.now() / 1000);
		const payload = ClusterReconfigureAcknowledgementPayloadV3Schema.parse({
			...input,
			// Key names only. A value here would put an operator secret into Hub
			// persistence and Hub logs.
			appliedKeys: [...input.appliedKeys].sort(),
			protocolVersion: MCP_PROTOCOL_V3,
			type: 'cluster-reconfigure-acknowledgement',
			iss: this.issuer,
			aud: 'privos-hub-api',
			jti: crypto.randomUUID(),
			nonce: crypto.randomBytes(24).toString('base64url'),
			iat: now,
			exp: now + lifetimeSeconds,
		});
		const compact = signEs256Jws({
			payload,
			privateJwk: material.privateJwk,
			kid: material.record.kid,
			typ: 'privos-cluster-reconfigure-ack+jws',
			protocolVersion: MCP_PROTOCOL_V3,
		});
		return { payload, compact, artifactHash: sha256Base64Url(compact), kid: material.record.kid };
	}

	async signUpgradeAcknowledgement(
		input: UpgradeAcknowledgementInput,
		lifetimeSeconds = 300,
	): Promise<{
		payload: ClusterUpgradeAcknowledgementPayloadV3;
		compact: string;
		artifactHash: string;
		kid: string;
	}> {
		if (input.clusterId !== this.clusterId) throw new Error('cluster_acknowledgement_affinity_mismatch');
		if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 300) {
			throw new Error('cluster_acknowledgement_lifetime_invalid');
		}
		const material = await this.load();
		const now = Math.floor(Date.now() / 1000);
		const payload = ClusterUpgradeAcknowledgementPayloadV3Schema.parse({
			...input,
			protocolVersion: MCP_PROTOCOL_V3,
			type: 'cluster-upgrade-acknowledgement',
			iss: this.issuer,
			aud: 'privos-hub-api',
			jti: crypto.randomUUID(),
			nonce: crypto.randomBytes(24).toString('base64url'),
			iat: now,
			exp: now + lifetimeSeconds,
		});
		const compact = signEs256Jws({
			payload,
			privateJwk: material.privateJwk,
			kid: material.record.kid,
			typ: 'privos-cluster-upgrade-ack+jws',
			protocolVersion: MCP_PROTOCOL_V3,
		});
		return { payload, compact, artifactHash: sha256Base64Url(compact), kid: material.record.kid };
	}

	private load(): Promise<IdentityMaterial> {
		this.loaded ??= this.loadOrCreate();
		return this.loaded;
	}

	private async loadOrCreate(): Promise<IdentityMaterial> {
		const existing = await this.repositories.clusterSigningIdentities.findOne({ clusterId: this.clusterId });
		if (existing) return this.open(existing);

		const generated = generateNodeIdentity(this.identityId);
		const now = new Date();
		const record: ClusterSigningIdentityRecord = {
			_id: this.identityId,
			version: 1,
			clusterId: this.clusterId,
			identityId: this.identityId,
			issuer: this.issuer,
			algorithm: 'ES256',
			kid: generated.kid,
			publicJwk: generated.publicJwk,
			encryptedPrivateJwk: this.cipher.encrypt(JSON.stringify(generated.privateJwk)),
			createdAt: now,
			updatedAt: now,
		};
		try {
			await this.repositories.clusterSigningIdentities.insertOne(record);
			return { record, privateJwk: generated.privateJwk };
		} catch (error: unknown) {
			if ((error as { code?: number }).code !== 11000) throw error;
			const raced = await this.repositories.clusterSigningIdentities.findOne({ clusterId: this.clusterId });
			if (!raced) throw error;
			return this.open(raced);
		}
	}

	private open(record: ClusterSigningIdentityRecord): IdentityMaterial {
		if (
			record.version !== 1 ||
			record.clusterId !== this.clusterId ||
			record.identityId !== this.identityId ||
			record.issuer !== this.issuer ||
			record.algorithm !== 'ES256'
		) {
			throw new Error('cluster_signing_identity_invalid');
		}
		let privateJwk: JsonWebKey;
		try {
			privateJwk = JSON.parse(this.cipher.decrypt(record.encryptedPrivateJwk)) as JsonWebKey;
		} catch {
			throw new Error('cluster_signing_identity_invalid');
		}
		const stored: StoredNodeIdentity = {
			version: 1,
			nodeId: this.identityId,
			privateJwk,
			publicJwk: record.publicJwk,
			kid: record.kid,
			createdAt: record.createdAt.toISOString(),
		};
		try {
			validateNodeIdentity(stored, this.identityId);
		} catch {
			throw new Error('cluster_signing_identity_invalid');
		}
		return { record, privateJwk };
	}
}
