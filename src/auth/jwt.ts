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
	const decoded = jwt.verify(token, config.JWT_SECRET, {
		algorithms: ['HS256'],
		...(expectedIssuer && { issuer: expectedIssuer }),
	});
	return decoded as JwtClaims;
}
