/**
 * Admin login endpoint for the cluster web UI.
 *
 * Behavior:
 *   - Validates credentials against ADMIN_USERNAME + ADMIN_PASSWORD env vars
 *     using a constant-time comparison to defeat timing attacks.
 *   - On success, mints a JWT with iss=privos-cluster-admin that the existing
 *     authenticate preHandler accepts on every other route.
 *   - If ADMIN_PASSWORD is empty, the route returns 503 — the admin flow is
 *     disabled and the operator must set a password to enable it.
 *
 * This is NOT meant for multi-user auth. It's a single-admin shim until SSO/OIDC
 * is wired up. Treat ADMIN_PASSWORD like a database password.
 */
import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { config } from '../config.js';

const LoginBodySchema = z.object({
    username: z.string().min(1).max(120),
    password: z.string().min(1).max(512),
});

function constantTimeEquals(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf-8');
    const bb = Buffer.from(b, 'utf-8');
    if (ab.length !== bb.length) {
        // Still run a comparison against ab against itself to keep timing flat.
        crypto.timingSafeEqual(ab, ab);
        return false;
    }
    return crypto.timingSafeEqual(ab, bb);
}

const authHandler: FastifyPluginAsync = async (fastify) => {
    fastify.post('/api/v1/auth/login', async (req, reply) => {
        if (!config.ADMIN_PASSWORD) {
            return reply.code(503).send({
                error: 'admin_login_disabled',
                hint: 'set ADMIN_PASSWORD in cluster env to enable the admin UI',
            });
        }

        const parsed = LoginBodySchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
        }

        const userOk = constantTimeEquals(parsed.data.username, config.ADMIN_USERNAME);
        const passOk = constantTimeEquals(parsed.data.password, config.ADMIN_PASSWORD);
        if (!userOk || !passOk) {
            // Single generic message — don't leak which field was wrong.
            return reply.code(401).send({ error: 'invalid_credentials' });
        }

        const token = fastify.jwt.sign(
            {
                iss: 'privos-cluster-admin',
                sub: parsed.data.username,
                scope: ['admin'],
            },
            { expiresIn: '12h' },
        );
        return reply.send({
            token,
            user: { username: parsed.data.username, scope: ['admin'] },
            expiresIn: 12 * 60 * 60,
        });
    });

    // Convenience: GET /api/v1/auth/me — verifies the current token and echoes the user.
    fastify.get('/api/v1/auth/me', { preHandler: fastify.authenticate }, async (req, reply) => {
        return reply.send({
            iss: req.clusterAuth?.iss,
            sub: req.clusterAuth?.sub,
        });
    });
};

export default fp(authHandler, { name: 'auth-routes' });
