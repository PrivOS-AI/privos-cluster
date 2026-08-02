import crypto from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

export type ParsedJws = {
	header: Record<string, unknown>;
	payload: Record<string, unknown>;
	signingInput: Buffer;
	signature: Buffer;
};

function sortCanonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortCanonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sortCanonical(child)]),
		);
	}
	return value;
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortCanonical(value));
}

export function sha256(value: string | Buffer): string {
	return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function jwkThumbprint(jwk: JsonWebKey): string {
	if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y || jwk.d) {
		throw new Error('public_jwk_invalid');
	}
	return crypto
		.createHash('sha256')
		.update(canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
		.digest('base64url');
}

export function parseJws(compact: string): ParsedJws {
	const parts = compact.split('.');
	if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('artifact_signature_invalid');
	try {
		return {
			header: JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>,
			payload: JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>,
			signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
			signature: Buffer.from(parts[2]!, 'base64url'),
		};
	} catch {
		throw new Error('artifact_signature_invalid');
	}
}

export function verifyEs256Jws(input: {
	compact: string;
	publicJwk: JsonWebKey;
	typ: string;
	kid?: string;
}): ParsedJws {
	const parsed = parseJws(input.compact);
	if (
		parsed.header.alg !== 'ES256' ||
		parsed.header.typ !== input.typ ||
		(input.kid && parsed.header.kid !== input.kid)
	) {
		throw new Error('artifact_signature_invalid');
	}
	const key = crypto.createPublicKey({ key: input.publicJwk, format: 'jwk' });
	if (!crypto.verify('sha256', parsed.signingInput, { key, dsaEncoding: 'ieee-p1363' }, parsed.signature)) {
		throw new Error('artifact_signature_invalid');
	}
	return parsed;
}

export function signEs256Jws(input: {
	payload: Record<string, unknown>;
	privateJwk: JsonWebKey;
	kid: string;
	typ: string;
}): string {
	if (!input.privateJwk.d) throw new Error('private_jwk_invalid');
	const encodedHeader = Buffer.from(
		canonicalJson({ alg: 'ES256', kid: input.kid, typ: input.typ, privos_protocol: 2 }),
	).toString('base64url');
	const encodedPayload = Buffer.from(canonicalJson(input.payload)).toString('base64url');
	const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8');
	const key = crypto.createPrivateKey({ key: input.privateJwk, format: 'jwk' });
	const signature = crypto.sign('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
	return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function assertArtifactTime(
	payload: Record<string, unknown>,
	maximumLifetimeSeconds: number,
	nowSeconds = Math.floor(Date.now() / 1000),
): void {
	const iat = payload.iat;
	const exp = payload.exp;
	if (
		!Number.isInteger(iat) ||
		!Number.isInteger(exp) ||
		Number(iat) > nowSeconds + 30 ||
		Number(exp) < nowSeconds - 30 ||
		Number(exp) <= Number(iat) ||
		Number(exp) - Number(iat) > maximumLifetimeSeconds
	) {
		throw new Error('artifact_time_invalid');
	}
}
