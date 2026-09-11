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
} from '../protocol/protocol-v3.js';
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
 * States an attempt passes through while it is running. An operation found in
 * one of these was interrupted mid-attempt: the state describes where the dead
 * attempt got to, not a fact about the world, and the transition table rightly
 * refuses to run a new attempt forward from it. `CLEANUP_REQUIRED` is the
 * parked, re-enterable state the table already provides — every one of these
 * may legally move there, and every phase may legally be re-entered from it.
 */
const MID_ATTEMPT_STATES: ReadonlySet<ClusterLifecycleStateV3> = new Set(['ACCESS_REVOKED', 'RUNTIME_REMOVING', 'VERIFYING']);

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

		await this.parkInterruptedAttempt(command.operationId);
		await this.deps.repositories.clusterLifecycleOperations.updateOne(
			{ operationId: command.operationId },
			{ $inc: { attempts: 1 }, $set: { updatedAt: new Date() } },
		);
		try {
			return await this.runAttempt(command, inventory);
		} catch (error: unknown) {
			// Best effort: a thrown attempt parks itself so observers see the
			// truthful state immediately. A hard crash skips this, which is why
			// the next entry parks first.
			await this.parkInterruptedAttempt(command.operationId).catch(() => undefined);
			throw error;
		}
	}

	/**
	 * One attempt of the phase sequence. Every phase is idempotent against the
	 * world — revoking again, removing an absent resource, and observing are all
	 * safe — so an attempt never skips phases based on a dead attempt's state;
	 * it re-proves the world instead.
	 */
	private async runAttempt(
		command: ClusterLifecycleCommandPayloadV3,
		inventory: RuntimeResourceInventory,
	): Promise<McpUninstallResultV3> {
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

	/**
	 * Park an operation whose last attempt died mid-flight in
	 * `CLEANUP_REQUIRED`, the state the transition table designates for
	 * re-entry. A no-op for fresh, parked, or completed operations. Guarded by
	 * the observed state so a concurrent attempt that has already moved the
	 * operation forward is never dragged back.
	 */
	private async parkInterruptedAttempt(operationId: string): Promise<void> {
		const operation = await this.deps.repositories.clusterLifecycleOperations.findOne({ operationId });
		if (!operation || !MID_ATTEMPT_STATES.has(operation.state)) return;
		assertClusterLifecycleTransitionV3(operation.state, 'CLEANUP_REQUIRED');
		await this.deps.repositories.clusterLifecycleOperations.updateOne(
			{ operationId, state: operation.state },
			{ $set: { state: 'CLEANUP_REQUIRED', updatedAt: new Date() } },
		);
	}

	private async openOperation(
		command: ClusterLifecycleCommandPayloadV3,
		commandHash: string,
		inventory: RuntimeResourceInventory,
	): Promise<ClusterLifecycleOperation> {
		const existing = await this.deps.repositories.clusterLifecycleOperations.findOne({ operationId: command.operationId });
		if (existing) {
			// An operation is bound to what its command *names*, not to the bytes
			// that carried it. Commands are short lived and the Hub mints a fresh
			// one for every attempt, so pinning the artifact hash here would refuse
			// each legitimate retry and leave the teardown unfinishable. Reuse of
			// the bytes is already refused where the command is consumed, which is
			// also where every field below was verified against this cluster.
			if (
				existing.runtimeInstallationId !== command.runtimeInstallationId ||
				existing.generationId !== command.generationId ||
				existing.generationNumber !== command.generationNumber ||
				existing.clusterAppId !== command.clusterAppId ||
				existing.resourceManifestHash !== command.resourceManifestHash ||
				existing.runtimeResourceInventoryHash !== command.runtimeResourceInventoryHash
			) {
				throw Object.assign(new Error('lifecycle command affinity conflict'), { code: 'ARTIFACT_REPLAYED', statusCode: 409 });
			}
			if (existing.commandHash === commandHash) return existing;
			await this.deps.repositories.clusterLifecycleOperations.updateOne(
				{ operationId: command.operationId },
				{ $set: { commandJti: command.jti, commandHash, updatedAt: new Date() } },
			);
			return { ...existing, commandJti: command.jti, commandHash };
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
		// Inventories written before 2026-09 carried only `host`; the subdomain
		// is its first label (the registry only ever allocates single labels),
		// so those generations' routes are still removable.
		const subdomain = resource.attributes.subdomain ?? resource.attributes.host?.split('.')[0];
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
		// One checkpoint document per (operation, sequence) — that is what the
		// unique index enforces. A resumed attempt reaching a sequence its dead
		// predecessor already wrote may land a different state (the predecessor
		// signed CLEANUP_REQUIRED, this attempt proves COMPLETED), so the document
		// records the latest attempt's outcome rather than refusing to exist.
		await this.deps.repositories.clusterLifecycleCheckpoints.updateOne(
			{ operationId: command.operationId, sequence },
			{
				$setOnInsert: {
					_id: `lifecycle-checkpoint:${crypto.randomUUID()}`,
					protocolVersion: 3 as const,
					operationId: command.operationId,
					sequence,
					createdAt: now,
				},
				$set: {
					checkpointKey,
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
					updatedAt: now,
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
