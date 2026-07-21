import fp from 'fastify-plugin';
import jwtPlugin from '@fastify/jwt';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Type augmentation
// ---------------------------------------------------------------------------
declare module 'fastify' {
	interface FastifyInstance {
		authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
	}
	interface FastifyRequest {
		clusterAuth?: { iss: string; sub?: string };
	}
}

declare module '@fastify/jwt' {
	interface FastifyJWT {
		payload: { iss: string; sub: string; scope?: string[] };
		user: { iss: string; sub: string; scope?: string[] };
	}
}

// Accepted token issuer — the cluster trusts only service-to-service tokens
// signed by the privos-chat (hub) backend. There is no local admin auth flow.
const ALLOWED_ISSUERS = ['privos-chat'] as const;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
const authPlugin: FastifyPluginAsync = async (fastify) => {
	// Register @fastify/jwt with shared secret. Only `verify` is configured —
	// this service never signs its own tokens (no local login flow).
	await fastify.register(jwtPlugin, {
		secret: config.JWT_SECRET,
		verify: { allowedIss: ALLOWED_ISSUERS as unknown as string[] },
	});

	// Reusable preHandler that verifies inbound Bearer tokens.
	fastify.decorate(
		'authenticate',
		async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
			try {
				await req.jwtVerify();
				if (!ALLOWED_ISSUERS.includes(req.user.iss as (typeof ALLOWED_ISSUERS)[number])) {
					throw new Error('bad issuer');
				}
				req.clusterAuth = { iss: req.user.iss, sub: req.user.sub };
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : 'unknown error';
				return reply.code(401).send({ error: 'unauthorized', reason: message });
			}
		},
	);
};

export default fp(authPlugin, { name: 'auth' });
