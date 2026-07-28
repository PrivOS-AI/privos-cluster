import jwt from 'jsonwebtoken';
import type { MasterNode } from './types.js';
import { KeyCipher } from './key-crypto.js';

export interface AgentResponse {
	status: number;
	headers: Record<string, string>;
	body: unknown;
}

export class AgentClient {
	constructor(private readonly cipher: KeyCipher) {}

	async request(
		node: MasterNode,
		workspaceId: string,
		method: string,
		path: string,
		body?: unknown,
	): Promise<AgentResponse> {
		const fleetKey = this.cipher.decrypt(node.encryptedFleetKey);
		const token = jwt.sign(
			{ sub: 'apps-master', workspaceId },
			fleetKey,
			{
				algorithm: 'HS256',
				issuer: 'privos-apps-master',
				expiresIn: '2m',
				keyid: node.keyId,
			},
		);
		const response = await fetch(`${node.url.replace(/\/$/, '')}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const contentType = response.headers.get('content-type') ?? '';
		const responseBody = contentType.includes('application/json')
			? await response.json()
			: await response.text();
		return {
			status: response.status,
			headers: Object.fromEntries(response.headers.entries()),
			body: responseBody,
		};
	}
}
