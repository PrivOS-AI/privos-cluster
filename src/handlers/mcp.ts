import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';

import { config } from '../config.js';
import { imageManager } from '../docker/index.js';
import { resolveImmutableImageReference } from '../docker/image-reference.js';
import { McpDeployRequestSchema } from '../schemas/app-schemas.js';
import { canonicalJson, sha256 } from '../security/artifacts.js';
import { deployManagedApp } from '../services/lifecycle-service.js';
import { nodeIdentity } from '../services/mcp-broker.js';
import { getClusterMcpMetrics, recordClusterMcpEvent } from '../services/mcp-observability.js';

const InspectSchema = z.object({
	image: z.string().min(1),
	digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

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
};

export default fp(mcpHandler, { name: 'mcp-handler' });
