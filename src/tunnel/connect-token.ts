/**
 * Signs the short-lived HS256 connect JWT the tunnel client presents on
 * every WebSocket upgrade to `wss://<hub>/api/v1/app-clusters.tunnel`
 * (wire-contracts.md "Connect JWT, `jti`, and the seen-`jti` cache").
 * `iss:'privos-app-cluster'`, `kid:<clusterId>`, a fresh `jti` per attempt,
 * 60 s TTL. Signed from the currently resolved cluster secret — the secret
 * itself never crosses the wire.
 */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

export const CONNECT_TOKEN_ISSUER = 'privos-app-cluster';
export const CONNECT_TOKEN_TTL_SECONDS = 60;

export function signConnectToken(clusterId: string, secret: string): string {
	return jwt.sign({}, secret, {
		algorithm: 'HS256',
		issuer: CONNECT_TOKEN_ISSUER,
		keyid: clusterId,
		jwtid: randomUUID(),
		expiresIn: CONNECT_TOKEN_TTL_SECONDS,
	});
}
