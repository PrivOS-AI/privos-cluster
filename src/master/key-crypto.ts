import crypto from 'node:crypto';

export function hashKey(value: string): string {
	return crypto.createHash('sha256').update(value).digest('hex');
}

export class KeyCipher {
	constructor(private readonly key: Buffer) {
		if (key.length !== 32) throw new Error('KeyCipher requires a 32-byte key');
	}

	encrypt(plaintext: string): string {
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
		const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
		const tag = cipher.getAuthTag();
		return Buffer.concat([iv, tag, ciphertext]).toString('base64');
	}

	decrypt(value: string): string {
		const packed = Buffer.from(value, 'base64');
		const iv = packed.subarray(0, 12);
		const tag = packed.subarray(12, 28);
		const ciphertext = packed.subarray(28);
		const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
	}
}
