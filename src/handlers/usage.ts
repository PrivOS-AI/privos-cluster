import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { getWorkspaceUsage } from '../services/workspace-usage-service.js';

const usageHandler: FastifyPluginAsync = async (fastify) => {
	fastify.get('/api/v1/usage', { preHandler: fastify.authenticate }, async (req, reply) => {
		const workspaceId = req.clusterAuth?.workspaceId;
		if (config.FLEET_MODE && !workspaceId) {
			return reply.code(403).send({ error: 'workspace_scope_required' });
		}
		if (!workspaceId) {
			return reply.code(400).send({ error: 'usage_requires_workspace_scope' });
		}
		return reply.send(await getWorkspaceUsage(workspaceId));
	});
};

export default fp(usageHandler, { name: 'usage-handler' });
