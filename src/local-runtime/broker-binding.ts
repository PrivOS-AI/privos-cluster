/**
 * Builds the MANAGED identity broker's binding documents (`McpRuntimeBindingV3`)
 * for a `privos-local-runtime-driver-v1` replica, so the same untouched
 * `McpBrokerManager` that already serves MANAGED workloads can attest for a
 * driver-supervised container too — PREACTIVATION gets a provisioning binding
 * (attest refused until inventory is established), ACTIVATE gets the
 * finalized one.
 *
 * The driver ABI has no `runtime_approval_receipt_hash` / `runtime_authorization_epoch`
 * until ACTIVATE (`abi-schema.ts`'s `EnsureReadyRequest` carries neither), yet
 * `McpRuntimeBindingV3` requires both unconditionally. At PREACTIVATION this
 * fills them with deterministic values derived from already hash-bound
 * affinity fields (`permission_contract_hash`, `generation_number`) — inert
 * placeholders the broker never trusts anyway, because `respond()` refuses
 * `attest` on any binding with no `runtimeResourceInventoryHash` regardless of
 * what its approval/epoch fields say. They are NEVER carried onto the ACTIVE
 * container: ACTIVATE recreates the container from scratch under a brand new
 * replica id and binding built from the real ACTIVATE values.
 */
import type { JsonWebKey } from 'node:crypto';

import { buildMcpRuntimeResourceLabelsV3 } from '../security/mcp-resource-labels-v3.js';
import { readPairedClusterId } from '../state-dir.js';
import type { McpRuntimeBindingV3 } from '../types/index.js';
import type { ActivateRequest, EnsureReadyRequest } from './abi-schema.js';

export interface LocalRuntimeBrokerContext {
	/** The App Cluster's own state dir — where the Hub-assigned cluster id is persisted at pairing. */
	stateDir: string;
	/** Used only before this cluster has ever paired. */
	fallbackClusterId: string;
	nodeId: string;
	/** The Hub's public origin (`resolveHubOrigin` in `config.ts`) — the driver ABI carries no hub-origin field (no ABI change); the broker hands it to the app over the attested socket response instead. */
	hubOrigin: string;
	/** The private local-runtime network name — becomes the binding's `networkName`, which the broker checks the container is attached to before attesting. */
	networkName: string;
}

export type LocalRuntimeBrokerBinding = McpRuntimeBindingV3 & { dockerContainerId: string; networkName: string };

/**
 * One shared label set — consumed both by `runtime-service.ts`'s container
 * policy and (via a real broker `respond()` round trip) by
 * `local-runtime-broker.test.ts` — so drift between "what the driver labels
 * the container" and "what the broker expects to see" is a failing test, not
 * a field incident. `privos.workspace`/`privos.id` are added on top of
 * `buildMcpRuntimeResourceLabelsV3`'s `privos.mcp.*` set because the MANAGED
 * install path gets them from its own generic `buildContainerLabels` call
 * (`docker/container-manager.ts`) — this driver has no equivalent, so the two
 * labels the broker also asserts on are added here instead.
 */
export const LOCAL_RUNTIME_BROKER_LABELS = (binding: McpRuntimeBindingV3): Record<string, string> => ({
	'privos.workspace': binding.workspaceId,
	'privos.id': binding.containerId,
	...buildMcpRuntimeResourceLabelsV3(binding, { kind: 'CONTAINER', resourceId: binding.containerId }),
});

/**
 * Builds the `McpRuntimeBindingV3` for a local-runtime replica. `activation`
 * is `null` for the PREACTIVATION (provisioning) binding and the finalized
 * `ActivateRequest` for the ACTIVATE binding — see the module doc for why the
 * PREACTIVATION shape still has to fill every required field. Overloaded so a
 * caller passing a real `ActivateRequest` gets back a binding whose
 * `runtimeResourceInventoryHash` is known `string` (required by
 * `McpBrokerManager.register`), not `string | undefined`.
 */
export function buildLocalRuntimeBinding(
	context: LocalRuntimeBrokerContext,
	request: EnsureReadyRequest,
	artifactDigest: string,
	runtimeId: string,
	replicaId: string,
	dockerContainerId: string,
	activation: ActivateRequest,
): LocalRuntimeBrokerBinding & { runtimeResourceInventoryHash: string };
export function buildLocalRuntimeBinding(
	context: LocalRuntimeBrokerContext,
	request: EnsureReadyRequest,
	artifactDigest: string,
	runtimeId: string,
	replicaId: string,
	dockerContainerId: string,
	activation: null,
): LocalRuntimeBrokerBinding & { runtimeResourceInventoryHash: undefined };
export function buildLocalRuntimeBinding(
	context: LocalRuntimeBrokerContext,
	request: EnsureReadyRequest,
	// The whole-artifact digest the driver reports as `artifact_digest` in its
	// own READY/ACTIVE evidence — the Hub stores that exact value and compares
	// a SELF_HOSTED_LOCAL attestation's `imageDigest` against it, so the
	// binding must carry the same digest byte-for-byte, never the image config
	// digest (`ArtifactStore`'s `configDigest`, a different value used only for
	// the Docker content-address pin).
	artifactDigest: string,
	runtimeId: string,
	replicaId: string,
	dockerContainerId: string,
	activation: ActivateRequest | null,
): LocalRuntimeBrokerBinding {
	const authorization = request.runtime_authorization;
	return {
		protocolVersion: 3,
		clusterId: readPairedClusterId(context.stateDir, context.fallbackClusterId),
		nodeId: context.nodeId,
		workspaceId: request.workspace_id,
		deploymentId: request.deployment_id,
		generationId: request.generation_id,
		generationNumber: request.generation_number,
		runtimeInstallationId: request.installation_id,
		mcpAppId: authorization.mcp_app_id,
		replicaId,
		containerId: runtimeId,
		dockerContainerId,
		imageDigest: artifactDigest,
		manifestDigest: authorization.manifest_digest,
		approvalReceiptHash: activation ? activation.runtime_approval_receipt_hash : request.permission_contract_hash,
		authorizationEpoch: activation ? activation.runtime_authorization_epoch : 0,
		deploymentGrantHash: request.descriptor_artifact_hash,
		resourceManifestHash: request.resource_manifest_hash,
		runtimeResourceInventoryHash: activation ? activation.runtime_resource_inventory_hash : undefined,
		hubOrigin: context.hubOrigin,
		hubKid: authorization.hub_kid,
		hubPublicJwk: authorization.hub_public_jwk as JsonWebKey,
		networkName: context.networkName,
	};
}
