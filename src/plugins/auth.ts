import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { resolveClusterSecret } from '../cluster-secret.js';

// ---------------------------------------------------------------------------
// Type augmentation
// ---------------------------------------------------------------------------
declare module 'fastify' {
	interface FastifyInstance {
		authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
	}
	interface FastifyRequest {
		clusterAuth?: { iss: string; sub?: string; workspaceId?: string; kid?: string };
	}
}

interface ClusterToken {
	iss: string;
	sub?: string;
	workspaceId?: string;
}

export interface ClusterAuth {
	iss: string;
	sub?: string;
	workspaceId?: string;
	kid?: string;
}

export function verifyClusterToken(
	token: string,
	options: {
		fleetMode: boolean;
		secret: string;
		nodeId?: string;
	},
): ClusterAuth {
	const decoded = jwt.decode(token, { complete: true });
	if (!decoded || typeof decoded === 'string') throw new Error('invalid token');
	const expectedIssuer = options.fleetMode ? 'privos-apps-master' : 'privos-chat';
	if (options.fleetMode && decoded.header.kid !== options.nodeId) {
		throw new Error('token kid does not match this node');
	}
	const payload = jwt.verify(token, options.secret, {
		algorithms: ['HS256'],
		issuer: expectedIssuer,
	}) as ClusterToken;
	if (options.fleetMode && !payload.workspaceId) {
		throw new Error('workspaceId claim is required');
	}
	return {
		iss: payload.iss,
		sub: payload.sub,
		workspaceId: payload.workspaceId,
		kid: decoded.header.kid,
	};
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
const authPlugin: FastifyPluginAsync = async (fastify) => {
	// Reusable preHandler that verifies inbound Bearer tokens.
	fastify.decorate(
		'authenticate',
		async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
			try {
				const authorization = req.headers.authorization;
				if (!authorization?.startsWith('Bearer ')) throw new Error('missing bearer token');
				const token = authorization.slice('Bearer '.length);
				// Resolved per request (not the boot-frozen config value) so a
				// credential acquired after boot, or rotated by a re-pair, takes
				// effect without a restart. Fleet mode is unaffected — it still
				// verifies against the fleet node key.
				const secret = config.FLEET_MODE ? config.FLEET_NODE_KEY : resolveClusterSecret();
				if (!secret) {
					return reply.code(401).send({ error: 'cluster_unpaired', reason: 'no cluster credential resolved' });
				}
				req.clusterAuth = verifyClusterToken(token, {
					fleetMode: config.FLEET_MODE,
					secret,
					nodeId: config.FLEET_NODE_ID,
				});
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : 'unknown error';
				return reply.code(401).send({ error: 'unauthorized', reason: message });
			}
		},
	);
};

export default fp(authPlugin, { name: 'auth' });
