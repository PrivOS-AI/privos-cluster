/**
 * Auth introspection route.
 *
 * The cluster trusts only tokens issued by privos-chat (verified by the
 * `authenticate` preHandler registered in plugins/auth.ts). This route lets
 * the hub confirm a token is valid and see which subject it belongs to —
 * used by the hub's cluster test-connection flow.
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

const authHandler: FastifyPluginAsync = async (fastify) => {
    fastify.get('/api/v1/auth/me', { preHandler: fastify.authenticate }, async (req, reply) => {
        return reply.send({
            iss: req.clusterAuth?.iss,
            sub: req.clusterAuth?.sub,
            workspaceId: req.clusterAuth?.workspaceId,
            kid: req.clusterAuth?.kid,
        });
    });
};

export default fp(authHandler, { name: 'auth-routes' });
