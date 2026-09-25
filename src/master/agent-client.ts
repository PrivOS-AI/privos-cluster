import jwt from 'jsonwebtoken';
import type { MasterNode } from './types.js';
import { KeyCipher } from './key-crypto.js';

export interface AgentResponse {
	status: number;
	headers: Record<string, string>;
	body: unknown;
}

/**
 * A fleet-mode agent token MUST carry a `workspaceId` claim (see
 * `src/plugins/auth.ts#verifyClusterToken`) — the tenant call this class was
 * built for always has a real one. A fleet-wide push (the host-table
 * publisher) has no single tenant to name, so it signs with this reserved
 * sentinel instead of inventing a second agent-side auth scheme. `__fleet__`
 * cannot collide with a real workspaceId (`/^[A-Za-z0-9-]+$/`, no
 * underscores), and the token is still bound to ONE node — signed with
 * that node's own fleet key and `keyid` — so it is exactly as node-scoped
 * as every other call this client makes.
 */
export const FLEET_SCOPED_WORKSPACE_ID = '__fleet__';

export class AgentClient {
	constructor(private readonly cipher: KeyCipher) {}

	async request(
		node: MasterNode,
		workspaceId: string,
		method: string,
		path: string,
		body?: unknown,
	): Promise<AgentResponse> {
		return this.send(node, workspaceId, method, path, body);
	}

	/** Node-scoped, not workspace-scoped — see `FLEET_SCOPED_WORKSPACE_ID`. Used only by the host-table publisher. */
	async fleetRequest(node: MasterNode, method: string, path: string, body?: unknown): Promise<AgentResponse> {
		return this.send(node, FLEET_SCOPED_WORKSPACE_ID, method, path, body, 'apps-master-fleet');
	}

	private async send(
		node: MasterNode,
		workspaceId: string,
		method: string,
		path: string,
		body: unknown,
		sub: string = 'apps-master',
	): Promise<AgentResponse> {
		const fleetKey = this.cipher.decrypt(node.encryptedFleetKey);
		const token = jwt.sign(
			{ sub, workspaceId },
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
