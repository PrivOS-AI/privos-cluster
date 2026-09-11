import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { resolveClusterSecret } from '../cluster-secret.js';

export interface JwtClaims {
	iss: string;
	sub?: string;
	iat?: number;
	exp?: number;
}

/**
 * Verify an inbound token. Throws if signature, expiry, or issuer check fails.
 * The verification key is resolved per call via `resolveClusterSecret()`, not
 * the boot-frozen `config.JWT_SECRET`, so a credential paired/rotated after
 * boot verifies without a restart.
 */
export function verifyToken(token: string, expectedIssuer?: string): JwtClaims {
	const secret = config.FLEET_MODE ? config.FLEET_NODE_KEY : resolveClusterSecret();
	if (!secret) throw new Error('JWT verification key is not configured');
	const decoded = jwt.verify(token, secret, {
		algorithms: ['HS256'],
		...(expectedIssuer && { issuer: expectedIssuer }),
	});
	return decoded as JwtClaims;
}
