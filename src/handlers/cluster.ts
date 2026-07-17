/**
 * Cluster-wide read/admin routes.
 * Currently exposes resource accounting + subdomain availability checks —
 * both used by the deploy wizard in the frontend.
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import * as containersRepo from '../db/containers-repo.js';
import { getClusterResources } from '../services/resource-check.js';
import { getDomains, resolveDomain, isReverseProxyEnabled } from '../services/settings-service.js';
import { SubdomainLabelSchema } from '../schemas/settings-schemas.js';

const clusterHandler: FastifyPluginAsync = async (fastify) => {
    // GET /api/v1/cluster/resources — host capacity + current allocation
    fastify.get(
        '/api/v1/cluster/resources',
        { preHandler: fastify.authenticate },
        async (_req, reply) => {
            try {
                const res = await getClusterResources();
                return reply.send(res);
            } catch (err: any) {
                fastify.log.error({ err }, 'cluster resources error');
                return reply.code(500).send({ error: err.message });
            }
        },
    );

    // GET /api/v1/cluster/domains — list configured base domains for the deploy UI
    fastify.get(
        '/api/v1/cluster/domains',
        { preHandler: fastify.authenticate },
        async (_req, reply) => {
            return reply.send({
                domains: getDomains(),
                reverseProxyEnabled: isReverseProxyEnabled(),
            });
        },
    );

    // GET /api/v1/cluster/subdomain-check?value=<label>&domain=<base>
    // Uniqueness is per full host (subdomain + domain).
    fastify.get(
        '/api/v1/cluster/subdomain-check',
        { preHandler: fastify.authenticate },
        async (req, reply) => {
            const { value, domain } = req.query as { value?: string; domain?: string };
            if (!value) return reply.code(400).send({ error: 'value query param required' });
            const parsed = SubdomainLabelSchema.safeParse(value);
            if (!parsed.success) {
                return reply.send({
                    available: false,
                    reason: parsed.error.issues[0]?.message ?? 'invalid label',
                });
            }
            const resolvedDomain = resolveDomain(domain);
            const existing = containersRepo.findByHost(parsed.data, resolvedDomain);
            if (existing) {
                return reply.send({
                    available: false,
                    reason: `taken by container ${existing.id}`,
                });
            }
            return reply.send({
                available: true,
                host: resolvedDomain ? `${parsed.data}.${resolvedDomain}` : null,
                domain: resolvedDomain,
                reverseProxyEnabled: isReverseProxyEnabled(),
            });
        },
    );
};

export default fp(clusterHandler, { name: 'cluster' });
