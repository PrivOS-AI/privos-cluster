import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

import { config } from '../config.js';
import { containerManager } from '../docker/index.js';
import { jwkThumbprint } from '../security/artifacts.js';
import { NodeIdentity } from '../security/node-identity.js';
import { getAppNetworkName } from './settings-service.js';
import { clusterMcpSafeReason, recordClusterMcpEvent } from './mcp-observability.js';

export const MCP_IDENTITY_SOCKET_PATH = '/run/privos/identity.sock';

export type McpReplicaBinding = {
	clusterId: string;
	nodeId: string;
	workspaceId: string;
	installationId: string;
	mcpAppId: string;
	replicaId: string;
	containerId: string;
	dockerContainerId: string;
	imageDigest: string;
	manifestDigest: string;
	receiptHash: string;
	grantEpoch: number;
	deploymentGrantHash: string;
	networkName: string;
	hubOrigin: string;
	hubKid: string;
	hubPublicJwk: JsonWebKey;
};

type BrokerRequest = { op: 'attest'; publicJwk: JsonWebKey; nonce: string };

function isBrokerRequest(value: unknown): value is BrokerRequest {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<BrokerRequest>;
	return (
		candidate.op === 'attest' &&
		Boolean(candidate.publicJwk) &&
		typeof candidate.nonce === 'string' &&
		/^[A-Za-z0-9_-]{16,128}$/.test(candidate.nonce)
	);
}

export class McpBrokerManager {
	private readonly servers = new Map<string, net.Server>();

	constructor(
		private readonly root: string,
		private readonly identity: NodeIdentity,
		private readonly inspectContainer: (id: string) => Promise<any>,
	) {}

	private directory(replicaId: string): string {
		if (!/^[0-9a-f-]{36}$/i.test(replicaId)) throw new Error('replica_id_invalid');
		return path.join(this.root, replicaId);
	}

	async prepare(replicaId: string): Promise<{ source: string; target: string }> {
		const directory = this.directory(replicaId);
		await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
		await fs.chmod(this.root, 0o700);
		await fs.mkdir(directory, { recursive: true, mode: 0o711 });
		await fs.chmod(directory, 0o711);
		return { source: directory, target: '/run/privos' };
	}

	async register(binding: McpReplicaBinding): Promise<{ source: string; target: string }> {
		await this.close(binding.replicaId);
		const directory = this.directory(binding.replicaId);
		const socketPath = path.join(directory, 'identity.sock');
		await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
		await fs.chmod(this.root, 0o700);
		await fs.mkdir(directory, { recursive: true, mode: 0o711 });
		await fs.chmod(directory, 0o711);
		await fs.rm(socketPath, { force: true });

		const server = net.createServer((socket) => {
			let buffered = '';
			socket.setEncoding('utf8');
			socket.on('data', (chunk) => {
				buffered += chunk;
				if (buffered.length > 16_384) socket.destroy(new Error('broker_request_too_large'));
				const lineEnd = buffered.indexOf('\n');
				if (lineEnd < 0) return;
				const line = buffered.slice(0, lineEnd);
				buffered = '';
				void this.respond(socket, binding, line);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(socketPath, () => {
				server.off('error', reject);
				resolve();
			});
		});
		await fs.chmod(socketPath, 0o666);
		this.servers.set(binding.replicaId, server);
		return { source: directory, target: '/run/privos' };
	}

	private async respond(socket: net.Socket, binding: McpReplicaBinding, raw: string): Promise<void> {
		try {
			const request = JSON.parse(raw) as unknown;
			if (!isBrokerRequest(request)) throw new Error('broker_request_invalid');
			await this.assertContainerBinding(binding);
			const now = Math.floor(Date.now() / 1000);
			const attestation = await this.identity.sign(
				{
					type: 'node-workload-attestation',
					iss: `urn:privos:cluster-node:${binding.clusterId}:${binding.nodeId}`,
					aud: 'privos-hub-api',
					iat: now,
					exp: now + 45,
					jti: crypto.randomUUID(),
					clusterId: binding.clusterId,
					nodeId: binding.nodeId,
					workspaceId: binding.workspaceId,
					installationId: binding.installationId,
					mcpAppId: binding.mcpAppId,
					replicaId: binding.replicaId,
					containerId: binding.containerId,
					imageDigest: binding.imageDigest,
					manifestDigest: binding.manifestDigest,
					receiptHash: binding.receiptHash,
					grantEpoch: binding.grantEpoch,
					dpopJkt: jwkThumbprint(request.publicJwk),
					nonce: request.nonce,
				},
				'privos-node-attestation+jws',
			);
			socket.end(`${JSON.stringify({
				ok: true,
				attestation,
				hubOrigin: binding.hubOrigin,
				hubKid: binding.hubKid,
				hubPublicJwk: binding.hubPublicJwk,
			})}\n`);
			recordClusterMcpEvent({ event: 'broker_attestation', outcome: 'allowed', boundary: 'unix_socket', reason: 'issued', correlationId: binding.installationId, emitLog: false });
		} catch (error: unknown) {
			const code = clusterMcpSafeReason(error, 'broker_request_failed');
			recordClusterMcpEvent({ event: 'broker_attestation', outcome: 'denied', boundary: 'unix_socket', reason: code, correlationId: binding.installationId });
			socket.end(`${JSON.stringify({ ok: false, error: code })}\n`);
		}
	}

	private async assertContainerBinding(binding: McpReplicaBinding): Promise<void> {
		const info = await this.inspectContainer(binding.dockerContainerId);
		if (!info?.State?.Running) throw new Error('container_not_running');
		const labels = (info.Config?.Labels ?? {}) as Record<string, string>;
		const expected: Record<string, string> = {
			'privos.workspace': binding.workspaceId,
			'privos.id': binding.containerId,
			'privos.mcp.installation': binding.installationId,
			'privos.mcp.replica': binding.replicaId,
			'privos.mcp.image.digest': binding.imageDigest,
			'privos.mcp.manifest.digest': binding.manifestDigest,
			'privos.mcp.receipt': binding.receiptHash,
			'privos.mcp.grant-epoch': String(binding.grantEpoch),
				'privos.mcp.deployment-grant-hash': binding.deploymentGrantHash,
				'privos.mcp.hub-kid': binding.hubKid,
			};
		if (Object.entries(expected).some(([key, value]) => labels[key] !== value)) {
			throw new Error('container_binding_mismatch');
		}
		if (!info.NetworkSettings?.Networks?.[binding.networkName]) throw new Error('container_network_mismatch');
	}

	async close(replicaId: string): Promise<void> {
		const server = this.servers.get(replicaId);
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			this.servers.delete(replicaId);
		}
	}

	async cleanup(replicaId: string): Promise<void> {
		await this.close(replicaId);
		await fs.rm(this.directory(replicaId), { recursive: true, force: true });
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.servers.keys()].map((replicaId) => this.close(replicaId)));
	}
}

export const nodeIdentity = new NodeIdentity(
	config.MCP_NODE_IDENTITY_KEY_PATH,
	config.FLEET_NODE_ID ?? 'local-node',
);

export const mcpBrokerManager = new McpBrokerManager(
	config.MCP_BROKER_ROOT,
	nodeIdentity,
	(id) => containerManager.inspectContainer(id),
);

export async function rebindMcpBrokers(): Promise<{ rebound: number; failed: number }> {
	let rebound = 0;
	let failed = 0;
	for (const listed of await containerManager.listMcpContainers()) {
		try {
			const info = await containerManager.inspectContainer(listed.Id);
			const labels = (info.Config?.Labels ?? {}) as Record<string, string>;
			if (labels['privos.mcp.schema'] !== '2') continue;
			const workspaceId = labels['privos.workspace'];
			const binding: McpReplicaBinding = {
				clusterId: labels['privos.mcp.cluster']!,
				nodeId: labels['privos.mcp.node']!,
				workspaceId,
				installationId: labels['privos.mcp.installation']!,
				mcpAppId: labels['privos.mcp.app']!,
				replicaId: labels['privos.mcp.replica']!,
				containerId: labels['privos.id']!,
				dockerContainerId: listed.Id,
				imageDigest: labels['privos.mcp.image.digest']!,
				manifestDigest: labels['privos.mcp.manifest.digest']!,
				receiptHash: labels['privos.mcp.receipt']!,
				grantEpoch: Number(labels['privos.mcp.grant-epoch']),
				deploymentGrantHash: labels['privos.mcp.deployment-grant-hash']!,
				networkName: getAppNetworkName(workspaceId),
				hubOrigin: labels['privos.mcp.hub-origin']!,
				hubKid: labels['privos.mcp.hub-kid']!,
				hubPublicJwk: JSON.parse(labels['privos.mcp.hub-jwk']!) as JsonWebKey,
			};
			if (Object.values(binding).some((value) => value === undefined || value === '' || Number.isNaN(value))) {
				throw new Error('persisted_broker_binding_invalid');
			}
			await mcpBrokerManager.register(binding);
			rebound += 1;
		} catch {
			failed += 1;
		}
	}
	return { rebound, failed };
}
