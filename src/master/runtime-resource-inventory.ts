import { canonicalJson, sha256Base64Url } from '../security/artifacts.js';
import {
	MCP_PROTOCOL_V3,
	RuntimeResourceDescriptorV3Schema,
	type RuntimeResourceDescriptorV3,
} from '../protocol/protocol-v3.js';
import type { RuntimeResourceInventory } from './types.js';

export type RuntimeResourceInventoryAffinityV3 = {
	clusterId: string;
	workspaceId: string;
	deploymentId: string;
	generationId: string;
	generationNumber: number;
	runtimeInstallationId: string;
	clusterAppId: string;
	manifestDigest: string;
	/** Canonical full cross-plane ownership/deletion manifest hash. */
	resourceManifestHash: string;
};

export type RuntimeReplicaResourcesV3 = {
	nodeId: string;
	nodeIdentityKid: string;
	replicaId: string;
	containerId: string;
	volumeNames: string[];
	brokerBindingIds: string[];
	brokerSocketIds: string[];
	serviceDiscoveryIds: string[];
};

export type RuntimeIngressResourceV3 = {
	routeId: string;
	nodeId?: string;
	replicaId?: string;
};

function assertInventoryAffinityV3(affinity: RuntimeResourceInventoryAffinityV3): void {
	if (
		![
			affinity.clusterId,
			affinity.workspaceId,
			affinity.deploymentId,
			affinity.generationId,
			affinity.runtimeInstallationId,
			affinity.clusterAppId,
		].every((value) => value.length > 0 && value.length <= 160) ||
		!Number.isInteger(affinity.generationNumber) || affinity.generationNumber < 1 ||
		!/^sha256:[a-f0-9]{64}$/.test(affinity.manifestDigest) ||
		!/^[A-Za-z0-9_-]{43}$/.test(affinity.resourceManifestHash)
	) throw new Error('runtime_resource_inventory_affinity_invalid');
}

function descriptorSortKey(resource: RuntimeResourceDescriptorV3): string {
	return `${resource.kind}\0${resource.resourceId}\0${canonicalJson(resource)}`;
}

export function normalizeRuntimeResourcesV3(
	resources: readonly RuntimeResourceDescriptorV3[],
): RuntimeResourceDescriptorV3[] {
	const parsed = resources.map((resource) => RuntimeResourceDescriptorV3Schema.parse(resource));
	const identities = new Set<string>();
	for (const resource of parsed) {
		const identity = `${resource.kind}\0${resource.resourceId}`;
		if (identities.has(identity)) throw new Error('runtime_resource_identity_duplicate');
		identities.add(identity);
	}
	return parsed.sort((left, right) => {
		const leftKey = descriptorSortKey(left);
		const rightKey = descriptorSortKey(right);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
}

/** Construct exact generation-owned resources from deterministic deploy IDs. */
export function buildExpectedRuntimeResourcesV3(input: {
	replicas: readonly RuntimeReplicaResourcesV3[];
	ingress: readonly RuntimeIngressResourceV3[];
}): RuntimeResourceDescriptorV3[] {
	const resources: RuntimeResourceDescriptorV3[] = [];
	for (const replica of input.replicas) {
		if (!/^[A-Za-z0-9_-]{16,128}$/.test(replica.nodeIdentityKid)) {
			throw new Error('runtime_resource_node_identity_invalid');
		}
		resources.push({
			kind: 'REPLICA',
			resourceId: replica.replicaId,
			ownershipScope: 'INSTALLATION_GENERATION',
			nodeId: replica.nodeId,
			replicaId: replica.replicaId,
			attributes: { nodeIdentityKid: replica.nodeIdentityKid },
		});
		resources.push({
			kind: 'CONTAINER',
			resourceId: replica.containerId,
			ownershipScope: 'INSTALLATION_GENERATION',
			nodeId: replica.nodeId,
			replicaId: replica.replicaId,
			attributes: { nodeIdentityKid: replica.nodeIdentityKid },
		});
		for (const volumeName of replica.volumeNames) {
			resources.push({
				kind: 'VOLUME',
				resourceId: volumeName,
				ownershipScope: 'INSTALLATION_GENERATION',
				nodeId: replica.nodeId,
				replicaId: replica.replicaId,
				attributes: {},
			});
		}
		for (const bindingId of replica.brokerBindingIds) {
			resources.push({
				kind: 'BROKER_BINDING',
				resourceId: bindingId,
				ownershipScope: 'INSTALLATION_GENERATION',
				nodeId: replica.nodeId,
				replicaId: replica.replicaId,
				attributes: {},
			});
		}
		for (const socketId of replica.brokerSocketIds) {
			resources.push({
				kind: 'BROKER_SOCKET',
				resourceId: socketId,
				ownershipScope: 'INSTALLATION_GENERATION',
				nodeId: replica.nodeId,
				replicaId: replica.replicaId,
				attributes: {},
			});
		}
		for (const serviceId of replica.serviceDiscoveryIds) {
			resources.push({
				kind: 'SERVICE_DISCOVERY',
				resourceId: serviceId,
				ownershipScope: 'INSTALLATION_GENERATION',
				nodeId: replica.nodeId,
				replicaId: replica.replicaId,
				attributes: {},
			});
		}
	}
	for (const route of input.ingress) {
		resources.push({
			kind: 'INGRESS',
			resourceId: route.routeId,
			ownershipScope: 'INSTALLATION_GENERATION',
			nodeId: route.nodeId ?? null,
			replicaId: route.replicaId ?? null,
			attributes: {},
		});
	}
	return normalizeRuntimeResourcesV3(resources);
}

/**
 * Hash the Cluster-local exact runtime inventory. This is intentionally a
 * separate domain from `resourceManifestHash`, which covers the canonical
 * full cross-plane ownership/deletion manifest validated by Hub.
 */
export function runtimeResourceInventoryHashV3(
	affinity: RuntimeResourceInventoryAffinityV3,
	resources: readonly RuntimeResourceDescriptorV3[],
): string {
	assertInventoryAffinityV3(affinity);
	return sha256Base64Url(canonicalJson({
		protocolVersion: MCP_PROTOCOL_V3,
		clusterId: affinity.clusterId,
		workspaceId: affinity.workspaceId,
		deploymentId: affinity.deploymentId,
		generationId: affinity.generationId,
		generationNumber: affinity.generationNumber,
		runtimeInstallationId: affinity.runtimeInstallationId,
		clusterAppId: affinity.clusterAppId,
		manifestDigest: affinity.manifestDigest,
		resourceManifestHash: affinity.resourceManifestHash,
		expectedResources: normalizeRuntimeResourcesV3(resources),
	}));
}

/** Pure constructor; callers supply identity and time for deterministic retries. */
export function buildRuntimeResourceInventoryV3(input: {
	inventoryId: string;
	affinity: RuntimeResourceInventoryAffinityV3;
	expectedResources: readonly RuntimeResourceDescriptorV3[];
	createdAt: Date;
	claimedRuntimeResourceInventoryHash?: string;
}): RuntimeResourceInventory & { runtimeResourceInventoryHash: string } {
	const capturing = buildCapturingRuntimeResourceInventoryV3({
		inventoryId: input.inventoryId,
		affinity: input.affinity,
		createdAt: input.createdAt,
	});
	const ready = finalizeRuntimeResourceInventoryV3(capturing, input.expectedResources, input.createdAt);
	if (
		input.claimedRuntimeResourceInventoryHash !== undefined &&
		input.claimedRuntimeResourceInventoryHash !== ready.runtimeResourceInventoryHash
	) throw new Error('runtime_resource_inventory_hash_mismatch');
	return ready;
}

export function buildCapturingRuntimeResourceInventoryV3(input: {
	inventoryId: string;
	affinity: RuntimeResourceInventoryAffinityV3;
	createdAt: Date;
}): RuntimeResourceInventory {
	if (!input.inventoryId || Number.isNaN(input.createdAt.getTime())) {
		throw new Error('runtime_resource_inventory_identity_invalid');
	}
	assertInventoryAffinityV3(input.affinity);
	return {
		_id: input.inventoryId,
		protocolVersion: MCP_PROTOCOL_V3,
		inventoryId: input.inventoryId,
		...input.affinity,
		expectedResources: [],
		observations: [],
		state: 'CAPTURING',
		createdAt: new Date(input.createdAt),
		updatedAt: new Date(input.createdAt),
	};
}

export function finalizeRuntimeResourceInventoryV3(
	inventory: RuntimeResourceInventory,
	resources: readonly RuntimeResourceDescriptorV3[],
	finalizedAt: Date,
): RuntimeResourceInventory & { runtimeResourceInventoryHash: string } {
	if (Number.isNaN(finalizedAt.getTime())) throw new Error('runtime_resource_inventory_identity_invalid');
	if (inventory.state !== 'CAPTURING' && inventory.state !== 'READY') {
		throw new Error('runtime_resource_inventory_not_finalizable');
	}
	const expectedResources = normalizeRuntimeResourcesV3(resources);
	if (expectedResources.length < 1) throw new Error('runtime_resource_inventory_empty');
	const runtimeResourceInventoryHash = runtimeResourceInventoryHashV3({
		clusterId: inventory.clusterId,
		workspaceId: inventory.workspaceId,
		deploymentId: inventory.deploymentId,
		generationId: inventory.generationId,
		generationNumber: inventory.generationNumber,
		runtimeInstallationId: inventory.runtimeInstallationId,
		clusterAppId: inventory.clusterAppId,
		manifestDigest: inventory.manifestDigest,
		resourceManifestHash: inventory.resourceManifestHash,
	}, expectedResources);
	if (
		inventory.state === 'READY' &&
		(inventory.runtimeResourceInventoryHash !== runtimeResourceInventoryHash ||
			canonicalJson(inventory.expectedResources) !== canonicalJson(expectedResources))
	) throw new Error('runtime_resource_inventory_finalization_conflict');
	return {
		...inventory,
		runtimeResourceInventoryHash,
		expectedResources,
		state: 'READY',
		updatedAt: new Date(finalizedAt),
	};
}
