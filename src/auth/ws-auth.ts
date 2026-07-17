import type { FastifyRequest } from 'fastify';

/**
 * Verify a JWT token passed as `?token=` query param for WebSocket connections.
 * Browsers cannot send Authorization headers on WS upgrade, so we accept
 * the token in the query string instead.
 *
 * Returns true if the token is valid, false otherwise.
 * Relies on the @fastify/jwt plugin being registered on the server.
 */
export async function verifyWsToken(req: FastifyRequest): Promise<boolean> {
	const token = (req.query as Record<string, unknown>)?.['token'];
	if (typeof token !== 'string') return false;
	try {
		// req.server.jwt is decorated by @fastify/jwt plugin
		await req.server.jwt.verify(token);
		return true;
	} catch {
		return false;
	}
}