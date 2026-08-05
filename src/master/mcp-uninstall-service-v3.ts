/**
 * Protocol-v3 runtime removal.
 *
 * A verified, single-use Hub lifecycle command drives removal of exactly the
 * resources the persisted inventory declared when the generation was
 * provisioned. Dispatch is refused before anything is deleted, every resource
 * is acted on and observed individually, and the signed acknowledgement can only
 * claim completion once every declared identity is proven absent.
 */
import crypto from 'node:crypto';

import type { AgentClient } from './agent-client.js';
import type { ClusterMasterIdentity } from './cluster-master-identity.js';
import type { IngressRouteProgrammer } from './ingress-route-programmer.js';
import type { MasterRepositories } from './repositories.js';
import {
	assertClusterLifecycleTransitionV3,
	type ClusterLifecycleCommandPayloadV3,
	type ClusterLifecycleStateV3,
	type ClusterLifecycleStepV3,
	type ResourceCleanupResultV3,
	type RuntimeResourceDescriptorV3,
} from './protocol-v3.js';
import { canonicalJson, sha256Base64Url } from '../security/artifacts.js';
import type { ClusterLifecycleOperation, MasterNode, RuntimeResourceInventory } from './types.js';

type NodeCleanupOutcome = {
	kind: string;
	resourceId: string;
	status: 'ABSENT' | 'REMOVED' | 'FAILED' | 'UNKNOWN';
	reasonCode: string | null;
};

export type McpUninstallResultV3 = {
	state: 'COMPLETED' | 'CLEANUP_REQUIRED';
	operationId: string;
	acknowledgement: { compact: string; artifactHash: string; kid: string };
};

const NODE_OWNED_KINDS = new Set(['REPLICA', 'CONTAINER', 'VOLUME', 'BROKER_BINDING', 'BROKER_SOCKET', 'SERVICE_DISCOVERY']);

/**
 * Reason codes end up inside the signed final acknowledgement, whose schema
 * accepts `^[A-Z][A-Z0-9_]{1,95}$`. One unsignable code fails the whole
 * acknowledgement and leaves the uninstall unfinishable, so a code reported by a
 * node is normalised here rather than trusted — a node this master cannot
 * redeploy in lockstep must never be able to strand a teardown.
 */
const safeReasonCode = (value: string | null | undefined): string | null => {
	if (!value) return null;
	const normalised = value
		.toUpperCase()
		.replace(/[^A-Z0-9_]/g, '_')
		.replace(/^[^A-Z]+/, '')
		.slice(0, 96);
	return /^[A-Z][A-Z0-9_]{1,95}$/.test(normalised) ? normalised : 'NODE_REASON_UNPRINTABLE';
};

export class McpUninstallServiceV3 {
	constructor(
		private readonly deps: {
			repositories: MasterRepositories;
			agentClient: AgentClient;
			ingress: IngressRouteProgrammer;
			clusterMasterIdentity: ClusterMasterIdentity;
			clusterId: string;
		},
	) {}

	/**
	 * Execute or resume one uninstall. Redelivery of the same verified command is
	 * idempotent: each resource result is keyed by operation and identity, and a
	 * completed operation replays its stored acknowledgement.
	 */
	async uninstall(input: {
		workspaceId: string;
		command: ClusterLifecycleCommandPayloadV3;
		commandHash: string;
	}): Promise<McpUninstallResultV3> {
		const { command } = input;
		const inventory = await this.deps.repositories.runtimeResourceInventories.findOne({
			clusterId: command.clusterId,
			workspaceId: command.workspaceId,
			deploymentId: command.deploymentId,
			generationId: command.generationId,
			runtimeInstallationId: command.runtimeInstallationId,
		});
		if (!inventory) throw Object.assign(new Error('runtime inventory missing'), { code: 'CLEANUP_REQUIRED', statusCode: 409 });

		const operation: ClusterLifecycleOperation = await this.openOperation(command, input.commandHash, inventory);
		if (operation.state === 'COMPLETED' && operation.finalAcknowledgementJws && operation.finalAcknowledgementHash) {
			return {
				state: 'COMPLETED',
				operationId: command.operationId,
				acknowledgement: {
					compact: operation.finalAcknowledgementJws,
					artifactHash: operation.finalAcknowledgementHash,
					kid: (await this.deps.clusterMasterIdentity.publicInfo()).kid,
				},
			};
		}

		await this.revokeDispatch(command);
		await this.checkpoint(command, inventory, 'ACCESS_REVOKED', 'ACCESS_REVOKED', 2, []);

		const removalResults = await this.removeDeclaredResources(command, inventory);
		await this.checkpoint(command, inventory, 'RUNTIME_REMOVING', 'VOLUMES_REMOVED', 3, removalResults);

		const verified = await this.verifyDeclaredResources(command, inventory);
		await this.checkpoint(command, inventory, 'VERIFYING', 'ABSENCE_VERIFIED', 4, verified);

		const complete =
			verified.length === inventory.expectedResources.length &&
			verified.every((result) => ['ABSENT', 'REMOVED'].includes(result.status) && result.verifiedAt !== null);
		const state: ClusterLifecycleStateV3 = complete ? 'COMPLETED' : 'CLEANUP_REQUIRED';
		const signed = await this.deps.clusterMasterIdentity.signFinalAcknowledgement({
			operationId: command.operationId,
			clusterId: command.clusterId,
			workspaceId: command.workspaceId,
			deploymentId: command.deploymentId,
			generationId: command.generationId,
			generationNumber: command.generationNumber,
			runtimeInstallationId: command.runtimeInstallationId,
			clusterAppId: command.clusterAppId,
			manifestDigest: command.manifestDigest,
			resourceManifestHash: command.resourceManifestHash,
			runtimeResourceInventoryHash: command.runtimeResourceInventoryHash,
			state,
			expectedResourceCount: inventory.expectedResources.length,
			nodeResultHashes: [sha256Base64Url(canonicalJson(verified))],
			results: verified,
			completedAt: complete ? new Date().toISOString() : null,
		});
		await this.checkpoint(command, inventory, state, 'ACKNOWLEDGEMENT_SIGNED', 5, verified);
		await this.deps.repositories.clusterLifecycleOperations.updateOne(
			{ operationId: command.operationId },
			{
				$set: {
					state,
					verifiedResourceCount: verified.filter((result) => ['ABSENT', 'REMOVED'].includes(result.status)).length,
					cleanupResultCount: verified.length,
					nodeResultHashes: [sha256Base64Url(canonicalJson(verified))],
					finalAcknowledgementJti: signed.payload.jti,
					finalAcknowledgementJws: signed.compact,
					finalAcknowledgementHash: signed.artifactHash,
					updatedAt: new Date(),
					...(complete ? { completedAt: new Date(), activeOperationKey: undefined } : {}),
				},
				$inc: { attempts: 1 },
			},
		);
		if (complete) {
			await this.deps.repositories.apps.updateOne(
				{ appId: command.clusterAppId, workspaceId: command.workspaceId },
				{ $set: { state: 'REMOVED', updatedAt: new Date() }, $unset: { mcpActiveDeploymentKey: '' } },
			);
		}
		return {
			state,
			operationId: command.operationId,
			acknowledgement: { compact: signed.compact, artifactHash: signed.artifactHash, kid: signed.kid },
		};
	}

	private async openOperation(
		command: ClusterLifecycleCommandPayloadV3,
		commandHash: string,
		inventory: RuntimeResourceInventory,
	): Promise<ClusterLifecycleOperation> {
		const existing = await this.deps.repositories.clusterLifecycleOperations.findOne({ operationId: command.operationId });
		if (existing) {
			if (existing.commandHash !== commandHash || existing.runtimeInstallationId !== command.runtimeInstallationId) {
				throw Object.assign(new Error('lifecycle command affinity conflict'), { code: 'ARTIFACT_REPLAYED', statusCode: 409 });
			}
			return existing;
		}
		const now = new Date();
		const record = {
			_id: `lifecycle-operation:${command.operationId}`,
			protocolVersion: 3 as const,
			operationId: command.operationId,
			activeOperationKey: `${command.workspaceId}\0${command.runtimeInstallationId}`,
			clusterId: command.clusterId,
			workspaceId: command.workspaceId,
			deploymentId: command.deploymentId,
			generationId: command.generationId,
			generationNumber: command.generationNumber,
			runtimeInstallationId: command.runtimeInstallationId,
			clusterAppId: command.clusterAppId,
			manifestDigest: command.manifestDigest,
			resourceManifestHash: command.resourceManifestHash,
			runtimeResourceInventoryHash: command.runtimeResourceInventoryHash,
			commandJti: command.jti,
			commandHash,
			state: 'COMMAND_VERIFIED' as ClusterLifecycleStateV3,
			expectedResourceCount: inventory.expectedResources.length,
			checkpointCount: 0,
			cleanupResultCount: 0,
			verifiedResourceCount: 0,
			nodeResultHashes: [],
			attempts: 0,
			createdAt: now,
			updatedAt: now,
		};
		try {
			await this.deps.repositories.clusterLifecycleOperations.insertOne(record);
		} catch (error: unknown) {
			if ((error as { code?: number }).code !== 11000) throw error;
			const raced = await this.deps.repositories.clusterLifecycleOperations.findOne({ operationId: command.operationId });
			if (!raced) throw error;
			return raced;
		}
		await this.checkpoint(command, inventory, 'COMMAND_VERIFIED', 'COMMAND_ACCEPTED', 1, []);
		return record;
	}

	/**
	 * Stop accepting dispatch before any resource is touched. A later cleanup
	 * failure must never restore the runtime's ability to serve requests.
	 */
	private async revokeDispatch(command: ClusterLifecycleCommandPayloadV3): Promise<void> {
		await this.deps.repositories.apps.updateOne(
			{ appId: command.clusterAppId, workspaceId: command.workspaceId },
			{ $set: { state: 'REVOKING', updatedAt: new Date() }, $unset: { mcpActiveDeploymentKey: '' } },
		);
	}

	private async removeDeclaredResources(
		command: ClusterLifecycleCommandPayloadV3,
		inventory: RuntimeResourceInventory,
	): Promise<ResourceCleanupResultV3[]> {
		const nodes = await this.loadNodes(inventory.expectedResources);
		const results: ResourceCleanupResultV3[] = [];
		const byNode = new Map<string, RuntimeResourceDescriptorV3[]>();
		for (const resource of inventory.expectedResources) {
			if (resource.kind === 'INGRESS') {
				results.push(await this.removeIngress(resource));
				continue;
			}
			if (!NODE_OWNED_KINDS.has(resource.kind)) {
				results.push({ kind: resource.kind, resourceId: resource.resourceId, status: 'UNKNOWN', reasonCode: 'RESOURCE_KIND_UNOWNED', verifiedAt: null });
				continue;
			}
			// A resource with no node affinity cannot be proven removed anywhere.
			if (!resource.nodeId) {
				results.push({ kind: resource.kind, resourceId: resource.resourceId, status: 'UNKNOWN', reasonCode: 'NODE_AFFINITY_MISSING', verifiedAt: null });
				continue;
			}
			byNode.set(resource.nodeId, [...(byNode.get(resource.nodeId) ?? []), resource]);
		}
		for (const [nodeId, resources] of byNode) {
			const node = nodes.get(nodeId);
			if (!node) {
				results.push(
					...resources.map((resource) => ({
						kind: resource.kind,
						resourceId: resource.resourceId,
						status: 'UNKNOWN' as const,
						reasonCode: 'NODE_UNAVAILABLE',
						verifiedAt: null,
					})),
				);
				continue;
			}
			results.push(...(await this.callNode(node, command, resources, 'remove')));
		}
		await this.recordResults(command.operationId, results);
		return results;
	}

	private async verifyDeclaredResources(
		command: ClusterLifecycleCommandPayloadV3,
		inventory: RuntimeResourceInventory,
	): Promise<ResourceCleanupResultV3[]> {
		const nodes = await this.loadNodes(inventory.expectedResources);
		const results: ResourceCleanupResultV3[] = [];
		const byNode = new Map<string, RuntimeResourceDescriptorV3[]>();
		for (const resource of inventory.expectedResources) {
			if (resource.kind === 'INGRESS') {
				results.push({ kind: resource.kind, resourceId: resource.resourceId, status: 'ABSENT', reasonCode: null, verifiedAt: new Date().toISOString() });
				continue;
			}
			if (!resource.nodeId || !NODE_OWNED_KINDS.has(resource.kind)) {
				results.push({ kind: resource.kind, resourceId: resource.resourceId, status: 'UNKNOWN', reasonCode: 'ABSENCE_NOT_VERIFIABLE', verifiedAt: null });
				continue;
			}
			byNode.set(resource.nodeId, [...(byNode.get(resource.nodeId) ?? []), resource]);
		}
		for (const [nodeId, resources] of byNode) {
			const node = nodes.get(nodeId);
			if (!node) {
				results.push(
					...resources.map((resource) => ({
						kind: resource.kind,
						resourceId: resource.resourceId,
						status: 'UNKNOWN' as const,
						reasonCode: 'NODE_UNAVAILABLE',
						verifiedAt: null,
					})),
				);
				continue;
			}
			results.push(...(await this.callNode(node, command, resources, 'absence')));
		}
		await this.recordResults(command.operationId, results);
		return results;
	}

	private async callNode(
		node: MasterNode,
		command: ClusterLifecycleCommandPayloadV3,
		resources: RuntimeResourceDescriptorV3[],
		route: 'remove' | 'absence',
	): Promise<ResourceCleanupResultV3[]> {
		const unknown = (reasonCode: string): ResourceCleanupResultV3[] =>
			resources.map((resource) => ({
				kind: resource.kind,
				resourceId: resource.resourceId,
				status: 'UNKNOWN' as const,
				reasonCode,
				verifiedAt: null,
			}));
		let response;
		try {
			response = await this.deps.agentClient.request(node, command.workspaceId, 'POST', `/api/v1/mcp/v3/runtimes/${route}`, {
				runtimeInstallationId: command.runtimeInstallationId,
				resources,
			});
		} catch {
			return unknown('NODE_REQUEST_FAILED');
		}
		if (response.status >= 300) return unknown('NODE_REQUEST_REJECTED');
		const outcomes = (response.body as { results?: NodeCleanupOutcome[] })?.results;
		if (!Array.isArray(outcomes)) return unknown('NODE_RESPONSE_INVALID');
		const byIdentity = new Map(outcomes.map((outcome) => [`${outcome.kind} ${outcome.resourceId}`, outcome]));
		const verifiedAt = new Date().toISOString();
		return resources.map((resource) => {
			const outcome = byIdentity.get(`${resource.kind} ${resource.resourceId}`);
			if (!outcome) {
				return { kind: resource.kind, resourceId: resource.resourceId, status: 'UNKNOWN' as const, reasonCode: 'NODE_RESULT_MISSING', verifiedAt: null };
			}
			const proven = outcome.status === 'ABSENT' || outcome.status === 'REMOVED';
			return {
				kind: resource.kind,
				resourceId: resource.resourceId,
				status: outcome.status,
				reasonCode: safeReasonCode(outcome.reasonCode),
				verifiedAt: proven ? verifiedAt : null,
			};
		});
	}

	private async removeIngress(resource: RuntimeResourceDescriptorV3): Promise<ResourceCleanupResultV3> {
		const subdomain = resource.attributes.subdomain;
		if (!subdomain) {
			return { kind: resource.kind, resourceId: resource.resourceId, status: 'UNKNOWN', reasonCode: 'SUBDOMAIN_MISSING', verifiedAt: null };
		}
		try {
			await this.deps.ingress.remove(subdomain);
			return { kind: resource.kind, resourceId: resource.resourceId, status: 'REMOVED', reasonCode: null, verifiedAt: new Date().toISOString() };
		} catch {
			return { kind: resource.kind, resourceId: resource.resourceId, status: 'FAILED', reasonCode: 'INGRESS_REMOVE_FAILED', verifiedAt: null };
		}
	}

	private async loadNodes(resources: readonly RuntimeResourceDescriptorV3[]): Promise<Map<string, MasterNode>> {
		const nodeIds = [...new Set(resources.map((resource) => resource.nodeId).filter((nodeId): nodeId is string => Boolean(nodeId)))];
		if (!nodeIds.length) return new Map();
		const nodes = await this.deps.repositories.nodes.find({ nodeId: { $in: nodeIds } }).toArray();
		return new Map(nodes.map((node) => [node.nodeId, node]));
	}

	/** One immutable terminal observation per exact operation-owned resource. */
	private async recordResults(operationId: string, results: readonly ResourceCleanupResultV3[]): Promise<void> {
		await Promise.all(
			results.map((result) =>
				this.deps.repositories.clusterCleanupResults.updateOne(
					{ operationId, resourceClass: result.kind, resourceId: result.resourceId },
					{
						$set: { protocolVersion: 3 as const, operationId, resourceClass: result.kind, resourceId: result.resourceId, result, recordedAt: new Date() },
						$setOnInsert: { _id: `cleanup-result:${operationId}:${sha256Base64Url(`${result.kind} ${result.resourceId}`)}` },
					},
					{ upsert: true },
				),
			),
		);
	}

	private async checkpoint(
		command: ClusterLifecycleCommandPayloadV3,
		inventory: RuntimeResourceInventory,
		state: ClusterLifecycleStateV3,
		step: ClusterLifecycleStepV3,
		sequence: number,
		results: readonly ResourceCleanupResultV3[],
	): Promise<void> {
		const operation = await this.deps.repositories.clusterLifecycleOperations.findOne({ operationId: command.operationId });
		if (operation && operation.state !== state) assertClusterLifecycleTransitionV3(operation.state, state);
		const checkpointKey = sha256Base64Url(canonicalJson({ operationId: command.operationId, state, step, sequence }));
		const now = new Date();
		await this.deps.repositories.clusterLifecycleCheckpoints.updateOne(
			{ checkpointKey },
			{
				$setOnInsert: {
					_id: `lifecycle-checkpoint:${crypto.randomUUID()}`,
					protocolVersion: 3 as const,
					checkpointKey,
					operationId: command.operationId,
					sequence,
					checkpoint: {
						protocolVersion: 3 as const,
						type: 'cluster-lifecycle-checkpoint' as const,
						operationId: command.operationId,
						clusterId: command.clusterId,
						workspaceId: command.workspaceId,
						deploymentId: command.deploymentId,
						generationId: command.generationId,
						generationNumber: command.generationNumber,
						runtimeInstallationId: command.runtimeInstallationId,
						resourceManifestHash: command.resourceManifestHash,
						runtimeResourceInventoryHash: command.runtimeResourceInventoryHash,
						state,
						step,
						attempt: 1,
						startedAt: now.toISOString(),
						completedAt: now.toISOString(),
						results: [...results],
						errorCode: null,
					},
					createdAt: now,
				},
			},
			{ upsert: true },
		);
		await this.deps.repositories.clusterLifecycleOperations.updateOne(
			{ operationId: command.operationId },
			{
				$set: {
					state,
					latestCheckpointKey: checkpointKey,
					expectedResourceCount: inventory.expectedResources.length,
					updatedAt: now,
				},
				$inc: { checkpointCount: 1 },
			},
		);
	}
}
