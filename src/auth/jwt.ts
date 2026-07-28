import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface JwtClaims {
	iss: string;
	sub?: string;
	iat?: number;
	exp?: number;
}

/**
 * Verify an inbound token. Throws if signature, expiry, or issuer check fails.
 */
export function verifyToken(token: string, expectedIssuer?: string): JwtClaims {
	const secret = config.FLEET_MODE ? config.FLEET_NODE_KEY : config.JWT_SECRET;
	if (!secret) throw new Error('JWT verification key is not configured');
	const decoded = jwt.verify(token, secret, {
		algorithms: ['HS256'],
		...(expectedIssuer && { issuer: expectedIssuer }),
	});
	return decoded as JwtClaims;
}
