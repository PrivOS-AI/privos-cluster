/**
 * Ed25519 request signing between the ingress and runtime proxy listeners.
 * The signature binds (targetNodeId, nonce, ts, method, host, request-target,
 * clientIp) so a runtime node can trust which node dialed it, that the
 * request is fresh, and which client IP to forward — without trusting any
 * header the client or a compromised hop could set directly.
 *
 * `method`/`host`/`requestTarget` are never transmitted as separate headers:
 * both sides recompute the signing string from the request they actually
 * see on the wire, so tampering with any of them in transit invalidates the
 * signature by itself — only `targetNodeId`/`nonce`/`ts`/`kid`/`clientIp`/
 * the signature travel as headers (see `runtime-listener.ts`/`ingress-listener.ts`).
 */
import crypto, { type KeyObject, type JsonWebKey } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface SignedRequestFields {
	/** The runtime node's mesh IP this request is signed for — see the phase-note
	 * in `ingress-listener.ts` on why this is a mesh IP rather than a fleet node id. */
	targetNodeId: string;
	nonce: string;
	ts: number;
	method: string;
	host: string;
	requestTarget: string;
	clientIp: string;
}

export interface SigningIdentity {
	nodeId: string;
	kid: string;
	privateKey: KeyObject;
	publicJwk: JsonWebKey;
}

interface StoredSigningKey {
	version: 1;
	nodeId: string;
	privateJwk: JsonWebKey;
	publicJwk: JsonWebKey;
	kid: string;
	createdAt: string;
}

function canonicalSigningString(fields: SignedRequestFields): string {
	return [
		fields.targetNodeId,
		fields.nonce,
		String(fields.ts),
		fields.method.toUpperCase(),
		fields.host,
		fields.requestTarget,
		fields.clientIp,
	].join('\n');
}

/** RFC 7638 thumbprint restricted to the OKP/Ed25519 shape this module signs with. */
function ed25519Thumbprint(jwk: JsonWebKey): string {
	if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x || jwk.d) throw new Error('signing_jwk_invalid');
	return crypto.createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest('base64url');
}

export function generateNonce(): string {
	return crypto.randomBytes(16).toString('hex');
}

export function signRequest(fields: SignedRequestFields, privateKey: KeyObject): string {
	return crypto.sign(null, Buffer.from(canonicalSigningString(fields)), privateKey).toString('base64');
}

/** `false` on any malformed input (bad base64, mismatched key shape) — never throws. */
export function verifyRequest(fields: SignedRequestFields, signatureBase64: string, publicJwk: JsonWebKey): boolean {
	try {
		const publicKey = crypto.createPublicKey({ key: publicJwk, format: 'jwk' });
		return crypto.verify(null, Buffer.from(canonicalSigningString(fields)), publicKey, Buffer.from(signatureBase64, 'base64'));
	} catch {
		return false;
	}
}

function validateStoredKey(value: StoredSigningKey, nodeId: string): StoredSigningKey {
	if (
		value.version !== 1 ||
		value.nodeId !== nodeId ||
		value.privateJwk.kty !== 'OKP' ||
		value.privateJwk.crv !== 'Ed25519' ||
		!value.privateJwk.d ||
		ed25519Thumbprint(value.publicJwk) !== value.kid
	) {
		throw new Error('ingress_signing_key_invalid');
	}
	return value;
}

function toIdentity(stored: StoredSigningKey): SigningIdentity {
	return {
		nodeId: stored.nodeId,
		kid: stored.kid,
		privateKey: crypto.createPrivateKey({ key: stored.privateJwk, format: 'jwk' }),
		publicJwk: stored.publicJwk,
	};
}

/**
 * Loads this node's Ed25519 signing key from `filePath`, generating and
 * persisting a fresh one (mode 0600) the first time. Mirrors
 * `security/node-identity.ts`'s create-if-missing shape for the MCP node
 * identity key. Publishing the resulting public key/kid into the master's
 * `signingKeys` table is out-of-band ops/bootstrap work — not this module's job.
 */
export async function loadOrCreateSigningIdentity(filePath: string, nodeId: string): Promise<SigningIdentity> {
	try {
		const stored = validateStoredKey(JSON.parse(await fs.readFile(filePath, 'utf8')) as StoredSigningKey, nodeId);
		return toIdentity(stored);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}

	const pair = crypto.generateKeyPairSync('ed25519');
	const publicJwk = pair.publicKey.export({ format: 'jwk' }) as JsonWebKey;
	const stored: StoredSigningKey = {
		version: 1,
		nodeId,
		privateJwk: pair.privateKey.export({ format: 'jwk' }) as JsonWebKey,
		publicJwk,
		kid: ed25519Thumbprint(publicJwk),
		createdAt: new Date().toISOString(),
	};

	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	try {
		await fs.writeFile(filePath, `${JSON.stringify(stored)}\n`, { flag: 'wx', mode: 0o600 });
		return toIdentity(stored);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		return toIdentity(validateStoredKey(JSON.parse(await fs.readFile(filePath, 'utf8')) as StoredSigningKey, nodeId));
	}
}
