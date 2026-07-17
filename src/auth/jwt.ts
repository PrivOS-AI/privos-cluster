import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { config } from '../config.js';

export interface JwtClaims {
	iss: string;
	sub?: string;
	iat?: number;
	exp?: number;
}

/**
 * Sign a short-lived service token.
 * Default issuer is 'privos-cluster'; privos-chat uses 'privos-chat'.
 */
export function signToken(iss: string, sub: string = 'service', expiresIn: SignOptions['expiresIn'] = '5m'): string {
	return jwt.sign({ sub }, config.JWT_SECRET, {
		algorithm: 'HS256',
		issuer: iss,
		expiresIn,
	});
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
