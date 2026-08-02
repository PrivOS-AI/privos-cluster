import crypto from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { jwkThumbprint, signEs256Jws } from './artifacts.js';

export type StoredNodeIdentity = {
	version: 1;
	nodeId: string;
	privateJwk: JsonWebKey;
	publicJwk: JsonWebKey;
	kid: string;
	createdAt: string;
};

export function validateNodeIdentity(value: StoredNodeIdentity, nodeId: string): StoredNodeIdentity {
	try {
		if (
			value.version !== 1 ||
			value.nodeId !== nodeId ||
			!value.privateJwk?.d ||
			value.privateJwk.kty !== 'EC' ||
			value.privateJwk.crv !== 'P-256' ||
			value.publicJwk?.d
		) {
			throw new Error('invalid key shape');
		}
		const privateKey = crypto.createPrivateKey({ key: value.privateJwk, format: 'jwk' });
		const derivedPublicJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
		if (
			derivedPublicJwk.kty !== value.publicJwk.kty ||
			derivedPublicJwk.crv !== value.publicJwk.crv ||
			derivedPublicJwk.x !== value.publicJwk.x ||
			derivedPublicJwk.y !== value.publicJwk.y ||
			jwkThumbprint(derivedPublicJwk) !== value.kid ||
			jwkThumbprint(value.publicJwk) !== value.kid
		) {
			throw new Error('public/private key mismatch');
		}
	} catch {
		throw new Error('node_identity_invalid');
	}
	return value;
}

export function generateNodeIdentity(nodeId: string): StoredNodeIdentity {
	if (!/^[A-Za-z0-9._:-]{1,128}$/.test(nodeId)) throw new Error('node_identity_invalid');
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const privateJwk = pair.privateKey.export({ format: 'jwk' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' });
	return {
		version: 1,
		nodeId,
		privateJwk,
		publicJwk,
		kid: jwkThumbprint(publicJwk),
		createdAt: new Date().toISOString(),
	};
}

/** Atomically rotate a node key after preserving a mode-0600 recovery copy. */
export async function rotateNodeIdentityFile(
	filePath: string,
	nodeId: string,
): Promise<{ previousKid: string; kid: string; backupPath: string }> {
	if (!path.isAbsolute(filePath) || filePath === path.parse(filePath).root) throw new Error('node_identity_path_invalid');
	const previous = validateNodeIdentity(JSON.parse(await fs.readFile(filePath, 'utf8')) as StoredNodeIdentity, nodeId);
	const next = generateNodeIdentity(nodeId);
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupPath = `${filePath}.pre-rotate-${timestamp}`;
	const temporaryPath = `${filePath}.next-${process.pid}-${crypto.randomUUID()}`;
	await fs.copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL);
	await fs.chmod(backupPath, 0o600);
	try {
		await fs.writeFile(temporaryPath, `${JSON.stringify(next)}\n`, { flag: 'wx', mode: 0o600 });
		await fs.rename(temporaryPath, filePath);
		await fs.chmod(filePath, 0o600);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true });
		throw error;
	}
	return { previousKid: previous.kid, kid: next.kid, backupPath };
}

export class NodeIdentity {
	private loaded?: Promise<StoredNodeIdentity>;

	constructor(
		private readonly filePath: string,
		private readonly nodeId: string,
	) {}

	private load(): Promise<StoredNodeIdentity> {
		this.loaded ??= this.loadOrCreate();
		return this.loaded;
	}

	private async loadOrCreate(): Promise<StoredNodeIdentity> {
		try {
			return validateNodeIdentity(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as StoredNodeIdentity, this.nodeId);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}

		const created = generateNodeIdentity(this.nodeId);
		await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		try {
			await fs.writeFile(this.filePath, `${JSON.stringify(created)}\n`, { flag: 'wx', mode: 0o600 });
			return created;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			return validateNodeIdentity(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as StoredNodeIdentity, this.nodeId);
		}
	}

	async publicInfo(): Promise<{ nodeId: string; kid: string; publicJwk: JsonWebKey }> {
		const identity = await this.load();
		return { nodeId: identity.nodeId, kid: identity.kid, publicJwk: identity.publicJwk };
	}

	async sign(payload: Record<string, unknown>, typ: string): Promise<string> {
		const identity = await this.load();
		return signEs256Jws({ payload, privateJwk: identity.privateJwk, kid: identity.kid, typ });
	}
}
