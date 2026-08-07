import assert from 'node:assert/strict';
import test from 'node:test';

import { ClusterMasterIdentity } from './cluster-master-identity.js';
import { KeyCipher } from './key-crypto.js';
import {
	verifyClusterFinalAcknowledgementV3,
	verifyClusterRuntimeInventoryAttestationV3,
} from './protocol-v3.js';
import { buildRuntimeResourceInventoryV3 } from './runtime-resource-inventory.js';
import type { ClusterSigningIdentityRecord, RuntimeResourceInventory } from './types.js';

function fakeRepositories() {
	let row: ClusterSigningIdentityRecord | undefined;
	const runtimeInventories: RuntimeResourceInventory[] = [];
	return {
		get row() { return row; },
		runtimeInventories,
		repositories: {
			clusterSigningIdentities: {
				findOne: async (filter: { clusterId?: string }) =>
					row && (!filter.clusterId || row.clusterId === filter.clusterId) ? row : null,
				insertOne: async (record: ClusterSigningIdentityRecord) => {
					if (row) throw Object.assign(new Error('duplicate'), { code: 11000 });
					row = record;
					return { acknowledged: true };
				},
			},
			runtimeResourceInventories: {
				findOne: async (filter: Record<string, unknown>) => runtimeInventories.find((inventory) =>
					Object.entries(filter).every(([key, value]) =>
						inventory[key as keyof RuntimeResourceInventory] === value)) ?? null,
				updateOne: async (
					filter: { _id: string; clusterId: string; state: string; runtimeInventoryAttestation: { $exists: false } },
					update: { $set: Pick<RuntimeResourceInventory, 'runtimeInventoryAttestation'> },
				) => {
					const inventory = runtimeInventories.find((candidate) =>
						candidate._id === filter._id &&
						candidate.clusterId === filter.clusterId &&
						candidate.state === filter.state &&
						candidate.runtimeInventoryAttestation === undefined);
					if (!inventory) return { matchedCount: 0 };
					inventory.runtimeInventoryAttestation = update.$set.runtimeInventoryAttestation;
					return { matchedCount: 1 };
				},
			},
		} as any,
	};
}

test('Cluster master identity persists encrypted and signs generation-affine final evidence', async () => {
	const state = fakeRepositories();
	const cipher = new KeyCipher(Buffer.alloc(32, 9));
	const first = new ClusterMasterIdentity(state.repositories, cipher, 'cluster-1');
	const firstPublic = await first.publicInfo();
	assert.equal(firstPublic.protocolVersion, 3);
	assert.equal(firstPublic.algorithm, 'ES256');
	assert.equal(firstPublic.artifactType, 'privos-cluster-final-cleanup-ack+jws');
	assert.deepEqual(firstPublic.artifactTypes, [
		'privos-cluster-runtime-inventory-attestation+jws',
		'privos-cluster-final-cleanup-ack+jws',
		'privos-cluster-reconfigure-ack+jws',
		'privos-cluster-upgrade-ack+jws',
	]);
	assert.equal(firstPublic.publicJwk.d, undefined);
	assert.ok(state.row);
	assert.equal(state.row?.publicJwk.d, undefined);
	assert.notEqual(state.row?.encryptedPrivateJwk.includes('"d"'), true);

	const replacementProcess = new ClusterMasterIdentity(state.repositories, cipher, 'cluster-1');
	const replacementPublic = await replacementProcess.publicInfo();
	assert.equal(replacementPublic.kid, firstPublic.kid);

	const resourceManifestHash = 'r'.repeat(43);
	const runtimeResourceInventoryHash = 'i'.repeat(43);
	const signed = await replacementProcess.signFinalAcknowledgement({
		operationId: '11111111-1111-4111-8111-111111111111',
		clusterId: 'cluster-1',
		workspaceId: 'workspace-1',
		deploymentId: 'deployment-1',
		generationId: 'generation-1',
		generationNumber: 1,
		runtimeInstallationId: 'runtime-1',
		clusterAppId: 'app-1',
		manifestDigest: `sha256:${'a'.repeat(64)}`,
		resourceManifestHash,
		runtimeResourceInventoryHash,
		state: 'COMPLETED',
		expectedResourceCount: 1,
		nodeResultHashes: ['n'.repeat(43)],
		results: [{
			kind: 'CONTAINER',
			resourceId: 'container-1',
			status: 'ABSENT',
			reasonCode: null,
			verifiedAt: new Date().toISOString(),
		}],
		completedAt: new Date().toISOString(),
	});
	assert.match(signed.artifactHash, /^[A-Za-z0-9_-]{43}$/);
	const verified = verifyClusterFinalAcknowledgementV3({
		compact: signed.compact,
		publicJwk: firstPublic.publicJwk,
		kid: firstPublic.kid,
		expected: {
			clusterId: 'cluster-1',
			workspaceId: 'workspace-1',
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 1,
			runtimeInstallationId: 'runtime-1',
			resourceManifestHash,
			runtimeResourceInventoryHash,
			issuer: firstPublic.issuer,
		},
	});
	assert.equal(verified.state, 'COMPLETED');
	await assert.rejects(replacementProcess.signFinalAcknowledgement({
		...verified,
		results: [{
			kind: 'CONTAINER',
			resourceId: 'container-1',
			status: 'FAILED',
			reasonCode: 'DOCKER_REMOVE_FAILED',
			verifiedAt: null,
		}],
	} as any), /completed acknowledgement must prove zero residue/);
	await assert.rejects(first.signFinalAcknowledgement({
		...verified,
		clusterId: 'cluster-2',
	} as any), /cluster_acknowledgement_affinity_mismatch/);
});

test('runtime inventory attestation requires complete persisted inventory and binds the initiating grant', async () => {
	const state = fakeRepositories();
	const signer = new ClusterMasterIdentity(state.repositories, new KeyCipher(Buffer.alloc(32, 7)), 'cluster-1');
	const deploymentGrantJti = '11111111-1111-4111-8111-111111111111';
	const inventoryId = 'inventory-1';
	await assert.rejects(
		signer.signRuntimeInventoryAttestation({ deploymentGrantJti, inventoryId }),
		/runtime_resource_inventory_not_ready/,
	);

	const inventory = buildRuntimeResourceInventoryV3({
		inventoryId,
		affinity: {
			clusterId: 'cluster-1',
			workspaceId: 'workspace-1',
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 1,
			runtimeInstallationId: 'runtime-1',
			clusterAppId: 'app-1',
			manifestDigest: `sha256:${'a'.repeat(64)}`,
			resourceManifestHash: 'r'.repeat(43),
		},
		expectedResources: [{
			kind: 'CONTAINER',
			resourceId: 'container-1',
			ownershipScope: 'INSTALLATION_GENERATION',
			nodeId: 'node-1',
			replicaId: '22222222-2222-4222-8222-222222222222',
			attributes: { nodeIdentityKid: 'node-identity-kid-1' },
		}],
		createdAt: new Date(),
	});
	inventory.state = 'CAPTURING';
	state.runtimeInventories.push(inventory);
	await assert.rejects(
		signer.signRuntimeInventoryAttestation({ deploymentGrantJti, inventoryId }),
		/runtime_resource_inventory_not_ready/,
	);

	inventory.state = 'READY';
	const signed = await signer.signRuntimeInventoryAttestation({ deploymentGrantJti, inventoryId });
	inventory.state = 'COMPACTED';
	const identicalRetry = await signer.signRuntimeInventoryAttestation({ deploymentGrantJti, inventoryId });
	assert.equal(identicalRetry.compact, signed.compact);
	assert.equal(identicalRetry.payload.jti, signed.payload.jti);
	await assert.rejects(
		signer.signRuntimeInventoryAttestation({
			deploymentGrantJti: '33333333-3333-4333-8333-333333333333',
			inventoryId,
		}),
		/runtime_inventory_attestation_conflict/,
	);
	const publicInfo = await signer.publicInfo();
	const expected = {
		clusterId: inventory.clusterId,
		workspaceId: inventory.workspaceId,
		deploymentId: inventory.deploymentId,
		generationId: inventory.generationId,
		generationNumber: inventory.generationNumber,
		runtimeInstallationId: inventory.runtimeInstallationId,
		resourceManifestHash: inventory.resourceManifestHash,
		issuer: publicInfo.issuer,
		deploymentGrantJti,
		clusterAppId: inventory.clusterAppId,
		manifestDigest: inventory.manifestDigest,
	};
	const verified = verifyClusterRuntimeInventoryAttestationV3({
		compact: signed.compact,
		publicJwk: publicInfo.publicJwk,
		kid: publicInfo.kid,
		expected,
	});
	assert.equal(verified.deploymentGrantJti, deploymentGrantJti);
	assert.equal(verified.runtimeResourceInventoryHash, inventory.runtimeResourceInventoryHash);
	assert.equal(verified.expectedResourceCount, 1);
	assert.throws(
		() => verifyClusterRuntimeInventoryAttestationV3({
			compact: signed.compact,
			publicJwk: publicInfo.publicJwk,
			kid: publicInfo.kid,
			expected: {
				...expected,
				deploymentGrantJti: '33333333-3333-4333-8333-333333333333',
			},
		}),
		(error: unknown) => (error as { code?: string }).code === 'GENERATION_AFFINITY_MISMATCH',
	);

	inventory.expectedResources[0] = {
		...inventory.expectedResources[0]!,
		resourceId: 'container-tampered',
	};
	await assert.rejects(
		signer.signRuntimeInventoryAttestation({ deploymentGrantJti, inventoryId }),
		/runtime_resource_inventory_invalid/,
	);
});
