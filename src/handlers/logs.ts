/**
 * Container logs endpoint.
 * GET /api/v1/apps/:containerId/logs?tail=100&timestamps=true
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import * as containersRepo from '../db/containers-repo.js';
import { containerManager } from '../docker/index.js';
import { ContainerIdParamSchema, LogsQuerySchema } from '../schemas/app-schemas.js';

const logsHandler: FastifyPluginAsync = async (fastify) => {
    fastify.get('/api/v1/apps/:containerId/logs', { preHandler: fastify.authenticate }, async (req, reply) => {
        try {
            const params = ContainerIdParamSchema.safeParse(req.params);
            if (!params.success) {
                return reply.code(400).send({ error: 'invalid containerId' });
            }

            const query = LogsQuerySchema.safeParse(req.query);
            if (!query.success) {
                return reply.code(400).send({ error: 'validation_error', details: query.error.issues });
            }

            const container = containersRepo.findById(params.data.containerId);
            if (!container) {
                return reply.code(404).send({ error: 'not found' });
            }

            // Clamp tail 1–5000
            const tail = Math.min(Math.max(query.data.tail, 1), 5000);
            const logs = await containerManager.getContainerLogs(
                container.dockerContainerId,
                tail,
                query.data.timestamps,
            );

            return reply.send({ logs });
        } catch (err: any) {
            fastify.log.error({ err }, 'logs error');
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });
};

export default fp(logsHandler, { name: 'logs-handler' });
