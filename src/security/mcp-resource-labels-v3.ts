import { canonicalJson } from './artifacts.js';
import type { McpRuntimeBindingV3 } from '../types/index.js';

export type McpRuntimeResourceLabelInputV3 = {
	kind: 'REPLICA' | 'CONTAINER' | 'INGRESS' | 'BROKER_BINDING' | 'BROKER_SOCKET' | 'SERVICE_DISCOVERY' | 'VOLUME';
	resourceId: string;
};

/**
 * Immutable, non-secret labels for exact protocol-v3 runtime ownership.
 * The helper is additive: current v2 deployment callers do not provide a v3
 * binding and therefore continue to emit their existing label schema.
 */
export function buildMcpRuntimeResourceLabelsV3(
	binding: McpRuntimeBindingV3,
	resource: McpRuntimeResourceLabelInputV3,
): Record<string, string> {
	return {
		'privos.mcp.schema': '3',
		'privos.mcp.cluster': binding.clusterId,
		'privos.mcp.node': binding.nodeId,
		'privos.mcp.workspace': binding.workspaceId,
		'privos.mcp.deployment': binding.deploymentId,
		'privos.mcp.generation': binding.generationId,
		'privos.mcp.generation-number': String(binding.generationNumber),
		'privos.mcp.runtime-installation': binding.runtimeInstallationId,
		'privos.mcp.app': binding.mcpAppId,
		'privos.mcp.replica': binding.replicaId,
		'privos.mcp.resource.kind': resource.kind,
		'privos.mcp.resource.id': resource.resourceId,
		'privos.mcp.image.digest': binding.imageDigest,
		'privos.mcp.manifest.digest': binding.manifestDigest,
		'privos.mcp.approval-receipt': binding.approvalReceiptHash,
		'privos.mcp.authorization-epoch': String(binding.authorizationEpoch),
		'privos.mcp.deployment-grant-hash': binding.deploymentGrantHash,
		'privos.mcp.resource-manifest-hash': binding.resourceManifestHash,
		...(binding.runtimeResourceInventoryHash
			? { 'privos.mcp.runtime-resource-inventory-hash': binding.runtimeResourceInventoryHash }
			: {}),
		'privos.mcp.hub-origin': binding.hubOrigin,
		'privos.mcp.hub-kid': binding.hubKid,
		'privos.mcp.hub-jwk': canonicalJson(binding.hubPublicJwk),
	};
}
