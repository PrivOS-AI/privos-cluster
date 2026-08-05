import type { FastifyPluginAsync } from 'fastify';
import type { JsonWebKey } from 'node:crypto';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { config } from '../config.js';
import { containerManager, imageManager } from '../docker/index.js';
import * as dockerState from '../docker/docker-state.js';
import { resolveImmutableImageReference } from '../docker/image-reference.js';
import {
	McpDeployRequestSchema,
	McpDeployRequestV3Schema,
} from '../schemas/app-schemas.js';
import { canonicalJson, sha256, sha256Base64Url } from '../security/artifacts.js';
import { deployManagedApp } from '../services/lifecycle-service.js';
import { mcpBrokerManager, nodeIdentity } from '../services/mcp-broker.js';
import { getClusterMcpMetrics, recordClusterMcpEvent } from '../services/mcp-observability.js';
import { getAppNetworkName } from '../services/settings-service.js';
import { RuntimeResourceDescriptorV3Schema } from '../master/protocol-v3.js';

const InspectSchema = z.object({
	image: z.string().min(1),
	digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

const FinalizeV3Schema = z.object({
	runtimeResourceInventoryHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

function localResourceId(prefix: string, ...parts: string[]): string {
	return `${prefix}-${sha256Base64Url(canonicalJson(parts))}`;
}

const mcpHandler: FastifyPluginAsync = async (fastify) => {
	fastify.get('/api/v1/mcp/node-identity', { preHandler: fastify.authenticate }, async () => ({
		clusterId: config.FLEET_CLUSTER_ID,
		...(await nodeIdentity.publicInfo()),
	}));

	fastify.get('/api/v1/mcp/metrics', { preHandler: fastify.authenticate }, async () => ({
		metrics: getClusterMcpMetrics(),
	}));

	// Pulling and inspecting image configuration does not create or execute an
	// application container. The Hub remains the permission-catalog authority.
	fastify.post('/api/v1/mcp/images/inspect', { preHandler: fastify.authenticate }, async (req, reply) => {
		const parsed = InspectSchema.safeParse(req.body);
		if (!parsed.success) {
			recordClusterMcpEvent({ event: 'manifest_preflight', outcome: 'denied', boundary: 'image_inspect', reason: 'validation_error' });
			return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
		}
		await imageManager.pull(parsed.data.image, 'latest', parsed.data.digest);
		const immutableReference = resolveImmutableImageReference(parsed.data.image, 'latest', parsed.data.digest);
		const image = await imageManager.inspect(immutableReference);
		if (!image || image.digest !== parsed.data.digest) {
			recordClusterMcpEvent({ event: 'manifest_preflight', outcome: 'denied', boundary: 'image_inspect', reason: 'image_digest_mismatch' });
			return reply.code(409).send({ error: 'image_digest_mismatch' });
		}
		const manifestRaw = image.labels['io.privos.mcp.manifest'];
		if (!manifestRaw) {
			recordClusterMcpEvent({ event: 'manifest_preflight', outcome: 'denied', boundary: 'image_inspect', reason: 'manifest_label_missing' });
			return reply.code(422).send({ error: 'mcp_manifest_label_missing' });
		}
		let manifest: unknown;
		try {
			manifest = JSON.parse(manifestRaw);
		} catch {
			recordClusterMcpEvent({ event: 'manifest_preflight', outcome: 'denied', boundary: 'image_inspect', reason: 'manifest_invalid' });
			return reply.code(422).send({ error: 'mcp_manifest_invalid' });
		}
		const manifestDigest = sha256(canonicalJson(manifest));
		const declaredDigest = image.labels['io.privos.mcp.manifest-digest'];
		if (declaredDigest && declaredDigest !== manifestDigest) {
			recordClusterMcpEvent({ event: 'manifest_preflight', outcome: 'denied', boundary: 'image_inspect', reason: 'manifest_digest_mismatch' });
			return reply.code(409).send({ error: 'manifest_digest_mismatch' });
		}
		recordClusterMcpEvent({ event: 'manifest_preflight', outcome: 'allowed', boundary: 'image_inspect', reason: 'verified', emitLog: false });
		return reply.send({
			image: parsed.data.image,
			imageDigest: parsed.data.digest,
			manifest,
			manifestDigest,
		});
	});

	fastify.post('/api/v1/mcp/apps/deploy', { preHandler: fastify.authenticate }, async (req, reply) => {
		if (config.REVERSE_PROXY_MODE !== 'native') {
			recordClusterMcpEvent({ event: 'deployment_grant', outcome: 'denied', boundary: 'agent_deploy', reason: 'private_ingress_unavailable' });
			return reply.code(503).send({ error: 'mcp_private_ingress_unavailable' });
		}
		const parsed = McpDeployRequestSchema.safeParse(req.body);
		if (!parsed.success) {
			recordClusterMcpEvent({ event: 'deployment_grant', outcome: 'denied', boundary: 'agent_deploy', reason: 'validation_error' });
			return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
		}
		if (
			parsed.data.mcpBinding.clusterId !== config.FLEET_CLUSTER_ID ||
			parsed.data.mcpBinding.nodeId !== config.FLEET_NODE_ID ||
			parsed.data.workspaceId !== req.clusterAuth?.workspaceId
		) {
			recordClusterMcpEvent({ event: 'deployment_grant', outcome: 'denied', boundary: 'agent_deploy', reason: 'runtime_binding_mismatch', correlationId: parsed.data.mcpBinding.installationId });
			return reply.code(403).send({ error: 'mcp_runtime_binding_mismatch' });
		}
		const container = await deployManagedApp(parsed.data);
		recordClusterMcpEvent({ event: 'deployment_grant', outcome: 'allowed', boundary: 'agent_deploy', reason: 'deployed', correlationId: parsed.data.mcpBinding.installationId });
		return reply.code(201).send({
			...container,
			nodeIdentity: await nodeIdentity.publicInfo(),
			replicaId: parsed.data.mcpBinding.replicaId,
		});
	});

	fastify.post('/api/v1/mcp/v3/apps/deploy', { preHandler: fastify.authenticate }, async (req, reply) => {
		if (config.APP_CLUSTER_MCP_INSTALL_V3 !== 'on') {
			return reply.code(404).send({ error: 'mcp_install_v3_disabled' });
		}
		if (config.REVERSE_PROXY_MODE !== 'native') {
			return reply.code(503).send({ error: 'mcp_private_ingress_unavailable' });
		}
		const parsed = McpDeployRequestV3Schema.safeParse(req.body);
		if (!parsed.success) {
			return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
		}
		const binding = parsed.data.mcpV3Binding;
		if (
			binding.clusterId !== config.FLEET_CLUSTER_ID ||
			binding.nodeId !== config.FLEET_NODE_ID ||
			parsed.data.workspaceId !== req.clusterAuth?.workspaceId
		) return reply.code(403).send({ error: 'mcp_runtime_binding_mismatch' });

		const container = await deployManagedApp(parsed.data);
		const [identity, inspect] = await Promise.all([
			nodeIdentity.publicInfo(),
			containerManager.inspectContainer(container.dockerContainerId),
		]);
		const expectedResources = RuntimeResourceDescriptorV3Schema.array().parse([
			{
				kind: 'REPLICA',
				resourceId: binding.replicaId,
				ownershipScope: 'INSTALLATION_GENERATION',
				nodeId: binding.nodeId,
				replicaId: binding.replicaId,
				attributes: { nodeIdentityKid: identity.kid },
			},
			{
				kind: 'CONTAINER',
				resourceId: binding.containerId,
				ownershipScope: 'INSTALLATION_GENERATION',
				nodeId: binding.nodeId,
				replicaId: binding.replicaId,
				attributes: { nodeIdentityKid: identity.kid },
			},
			...((inspect.Mounts ?? []) as Array<{ Type?: string; Name?: string; Destination?: string }>)
				.filter((mount) => mount.Type === 'volume' && mount.Name)
				.map((mount) => ({
					kind: 'VOLUME' as const,
					resourceId: mount.Name!,
					ownershipScope: 'INSTALLATION_GENERATION' as const,
					nodeId: binding.nodeId,
					replicaId: binding.replicaId,
					attributes: { mountPath: mount.Destination ?? '' },
				})),
			{
				kind: 'BROKER_BINDING',
				resourceId: localResourceId('broker-binding', binding.runtimeInstallationId, binding.replicaId),
				ownershipScope: 'INSTALLATION_GENERATION',
				nodeId: binding.nodeId,
				replicaId: binding.replicaId,
				attributes: {},
			},
			{
				kind: 'BROKER_SOCKET',
				resourceId: localResourceId('broker-socket', binding.runtimeInstallationId, binding.replicaId),
				ownershipScope: 'INSTALLATION_GENERATION',
				nodeId: binding.nodeId,
				replicaId: binding.replicaId,
				attributes: {},
			},
			{
				kind: 'SERVICE_DISCOVERY',
				resourceId: localResourceId('service', getAppNetworkName(binding.workspaceId), binding.containerId),
				ownershipScope: 'INSTALLATION_GENERATION',
				nodeId: binding.nodeId,
				replicaId: binding.replicaId,
				attributes: { networkName: getAppNetworkName(binding.workspaceId) },
			},
		]);
		return reply.code(201).send({
			...container,
			nodeIdentity: identity,
			replicaId: binding.replicaId,
			expectedResources,
		});
	});

	fastify.post('/api/v1/mcp/v3/apps/:containerId/finalize', { preHandler: fastify.authenticate }, async (req, reply) => {
		if (config.APP_CLUSTER_MCP_INSTALL_V3 !== 'on') {
			return reply.code(404).send({ error: 'mcp_install_v3_disabled' });
		}
		const containerId = (req.params as { containerId?: string }).containerId;
		const parsed = FinalizeV3Schema.safeParse(req.body);
		if (!containerId || !parsed.success) return reply.code(400).send({ error: 'validation_error' });
		const container = await dockerState.getById(containerId, undefined, req.clusterAuth?.workspaceId);
		if (!container) return reply.code(404).send({ error: 'not_found' });
		const inspect = await containerManager.inspectContainer(container.dockerContainerId);
		const labels = (inspect.Config?.Labels ?? {}) as Record<string, string>;
		if (labels['privos.mcp.schema'] !== '3' || labels['privos.id'] !== containerId) {
			return reply.code(409).send({ error: 'mcp_runtime_binding_mismatch' });
		}
		let hubPublicJwk: JsonWebKey;
		try {
			hubPublicJwk = JSON.parse(labels['privos.mcp.hub-jwk'] ?? '') as JsonWebKey;
		} catch {
			return reply.code(409).send({ error: 'mcp_runtime_binding_mismatch' });
		}
		await mcpBrokerManager.register({
			protocolVersion: 3,
			clusterId: labels['privos.mcp.cluster']!,
			nodeId: labels['privos.mcp.node']!,
			workspaceId: labels['privos.mcp.workspace']!,
			deploymentId: labels['privos.mcp.deployment']!,
			generationId: labels['privos.mcp.generation']!,
			generationNumber: Number(labels['privos.mcp.generation-number']),
			runtimeInstallationId: labels['privos.mcp.runtime-installation']!,
			mcpAppId: labels['privos.mcp.app']!,
			replicaId: labels['privos.mcp.replica']!,
			containerId,
			dockerContainerId: container.dockerContainerId,
			imageDigest: labels['privos.mcp.image.digest']!,
			manifestDigest: labels['privos.mcp.manifest.digest']!,
			approvalReceiptHash: labels['privos.mcp.approval-receipt']!,
			authorizationEpoch: Number(labels['privos.mcp.authorization-epoch']),
			deploymentGrantHash: labels['privos.mcp.deployment-grant-hash']!,
			resourceManifestHash: labels['privos.mcp.resource-manifest-hash']!,
			runtimeResourceInventoryHash: parsed.data.runtimeResourceInventoryHash,
			hubOrigin: labels['privos.mcp.hub-origin']!,
			hubKid: labels['privos.mcp.hub-kid']!,
			hubPublicJwk,
			networkName: getAppNetworkName(labels['privos.mcp.workspace']),
		});
		return { ok: true };
	});

	/**
	 * Remove exactly the resources the master's persisted inventory names.
	 *
	 * Container inspection is never the source of truth here: a container that is
	 * already gone, or an inspect that fails, must not silently skip its volumes.
	 * Every declared identity is acted on and reported individually so the master
	 * can prove absence instead of assuming it.
	 */
	fastify.post('/api/v1/mcp/v3/runtimes/remove', { preHandler: fastify.authenticate }, async (req, reply) => {
		if (config.APP_CLUSTER_MCP_INSTALL_V3 !== 'on') {
			return reply.code(404).send({ error: 'mcp_install_v3_disabled' });
		}
		const parsed = RuntimeCleanupBodySchema.safeParse(req.body);
		if (!parsed.success) return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
		const workspaceId = req.clusterAuth?.workspaceId;
		const results = [];
		for (const resource of parsed.data.resources) {
			results.push(await removeRuntimeResource(resource, workspaceId));
		}
		return { results };
	});

	fastify.post('/api/v1/mcp/v3/runtimes/absence', { preHandler: fastify.authenticate }, async (req, reply) => {
		if (config.APP_CLUSTER_MCP_INSTALL_V3 !== 'on') {
			return reply.code(404).send({ error: 'mcp_install_v3_disabled' });
		}
		const parsed = RuntimeCleanupBodySchema.safeParse(req.body);
		if (!parsed.success) return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
		const workspaceId = req.clusterAuth?.workspaceId;
		const results = [];
		for (const resource of parsed.data.resources) {
			results.push(await observeRuntimeResource(resource, workspaceId));
		}
		return { results };
	});
};

const RuntimeCleanupBodySchema = z
	.object({
		runtimeInstallationId: z.string().min(1).max(160),
		resources: z.array(RuntimeResourceDescriptorV3Schema).min(1).max(512),
	})
	.strict();

type RuntimeCleanupOutcome = {
	kind: string;
	resourceId: string;
	status: 'ABSENT' | 'REMOVED' | 'FAILED' | 'UNKNOWN';
	reasonCode: string | null;
};

const CONTAINER_KINDS = new Set(['REPLICA', 'CONTAINER']);

/**
 * Reason codes travel to the Hub inside a signed cleanup acknowledgement whose
 * schema accepts `^[A-Z][A-Z0-9_]{1,95}$`. A code that cannot be signed strands
 * the whole uninstall, so anything from outside — a Docker error `code`, say —
 * is normalised rather than trusted.
 */
const safeReasonCode = (value: string, fallback: string): string => {
	const normalised = value
		.toUpperCase()
		.replace(/[^A-Z0-9_]/g, '_')
		.replace(/^[^A-Z]+/, '')
		.slice(0, 96);
	return /^[A-Z][A-Z0-9_]{1,95}$/.test(normalised) ? normalised : fallback;
};

async function removeRuntimeResource(
	resource: z.infer<typeof RuntimeResourceDescriptorV3Schema>,
	workspaceId?: string,
): Promise<RuntimeCleanupOutcome> {
	const identity = { kind: resource.kind, resourceId: resource.resourceId };
	try {
		if (CONTAINER_KINDS.has(resource.kind)) {
			const containerId = resource.attributes.containerId;
			if (!containerId) return { ...identity, status: 'UNKNOWN', reasonCode: 'CONTAINER_ID_MISSING' };
			const container = await dockerState.getById(containerId, undefined, workspaceId);
			if (!container) return { ...identity, status: 'ABSENT', reasonCode: null };
			await containerManager.stopContainer(container.dockerContainerId, 10).catch(() => undefined);
			await containerManager.removeContainer(container.dockerContainerId, true);
			return { ...identity, status: 'REMOVED', reasonCode: null };
		}
		if (resource.kind === 'VOLUME') {
			const volumeName = resource.attributes.volumeName;
			if (!volumeName) return { ...identity, status: 'UNKNOWN', reasonCode: 'VOLUME_NAME_MISSING' };
			// The declared name removes the volume even when its container is long
			// gone, which a mount-derived list could never do.
			try {
				await containerManager.removeVolume(volumeName);
				return { ...identity, status: 'REMOVED', reasonCode: null };
			} catch (error: unknown) {
				if ((error as { statusCode?: number }).statusCode === 404) return { ...identity, status: 'ABSENT', reasonCode: null };
				throw error;
			}
		}
		if (resource.kind === 'BROKER_BINDING' || resource.kind === 'BROKER_SOCKET' || resource.kind === 'SERVICE_DISCOVERY') {
			const replicaId = resource.replicaId ?? resource.attributes.replicaId;
			if (!replicaId) return { ...identity, status: 'UNKNOWN', reasonCode: 'REPLICA_ID_MISSING' };
			await mcpBrokerManager.cleanup(replicaId);
			return { ...identity, status: 'REMOVED', reasonCode: null };
		}
		// Ingress is programmed by the master, not by a node agent.
		return { ...identity, status: 'UNKNOWN', reasonCode: 'RESOURCE_KIND_NOT_NODE_OWNED' };
	} catch (error: unknown) {
		return { ...identity, status: 'FAILED', reasonCode: safeReasonCode((error as { code?: string }).code ?? '', 'NODE_CLEANUP_FAILED') };
	}
}

async function observeRuntimeResource(
	resource: z.infer<typeof RuntimeResourceDescriptorV3Schema>,
	workspaceId?: string,
): Promise<RuntimeCleanupOutcome> {
	const identity = { kind: resource.kind, resourceId: resource.resourceId };
	try {
		if (CONTAINER_KINDS.has(resource.kind)) {
			const containerId = resource.attributes.containerId;
			if (!containerId) return { ...identity, status: 'UNKNOWN', reasonCode: 'CONTAINER_ID_MISSING' };
			const container = await dockerState.getById(containerId, undefined, workspaceId);
			return { ...identity, status: container ? 'FAILED' : 'ABSENT', reasonCode: container ? 'CONTAINER_STILL_PRESENT' : null };
		}
		if (resource.kind === 'VOLUME') {
			const volumeName = resource.attributes.volumeName;
			if (!volumeName) return { ...identity, status: 'UNKNOWN', reasonCode: 'VOLUME_NAME_MISSING' };
			const volumes = await containerManager.listVolumes();
			const present = volumes.some((volume: { Name?: string }) => volume?.Name === volumeName);
			return { ...identity, status: present ? 'FAILED' : 'ABSENT', reasonCode: present ? 'VOLUME_STILL_PRESENT' : null };
		}
		if (resource.kind === 'BROKER_BINDING' || resource.kind === 'BROKER_SOCKET' || resource.kind === 'SERVICE_DISCOVERY') {
			const replicaId = resource.replicaId ?? resource.attributes.replicaId;
			if (!replicaId) return { ...identity, status: 'UNKNOWN', reasonCode: 'REPLICA_ID_MISSING' };
			return { ...identity, status: mcpBrokerManager.isBound(replicaId) ? 'FAILED' : 'ABSENT', reasonCode: null };
		}
		return { ...identity, status: 'UNKNOWN', reasonCode: 'RESOURCE_KIND_NOT_NODE_OWNED' };
	} catch (error: unknown) {
		return { ...identity, status: 'UNKNOWN', reasonCode: safeReasonCode((error as { code?: string }).code ?? '', 'NODE_ABSENCE_CHECK_FAILED') };
	}
}

export default fp(mcpHandler, { name: 'mcp-handler' });
