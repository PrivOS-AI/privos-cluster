import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

import { config } from '../config.js';
import { containerManager } from '../docker/index.js';
import { canonicalJson, jwkThumbprint } from '../security/artifacts.js';
import { NodeIdentity } from '../security/node-identity.js';
import { getAppNetworkName } from './settings-service.js';
import { clusterMcpSafeReason, recordClusterMcpEvent } from './mcp-observability.js';
import type { McpRuntimeBindingV3 } from '../types/index.js';

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

export type McpReplicaBindingV3 = McpRuntimeBindingV3 & {
	protocolVersion: 3;
	dockerContainerId: string;
	networkName: string;
	runtimeResourceInventoryHash: string;
};

type McpProvisioningReplicaBindingV3 = McpRuntimeBindingV3 & {
	protocolVersion: 3;
	dockerContainerId: string;
	networkName: string;
	runtimeResourceInventoryHash?: undefined;
};

type AnyMcpReplicaBinding = McpReplicaBinding | McpReplicaBindingV3 | McpProvisioningReplicaBindingV3;

type PersistedMcpReplicaBindingV3 = Omit<McpReplicaBindingV3, 'dockerContainerId'> & { version: 1 };

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
		/**
		 * Durable home of the finalized v3 bindings. `root` lives on tmpfs and is wiped by a
		 * host reboot; this directory survives it. Unset keeps the socket directory as the
		 * only home (local runtime, tests).
		 */
		private readonly stateRoot?: string,
	) {}

	private assertReplicaId(replicaId: string): void {
		if (!/^[0-9a-f-]{36}$/i.test(replicaId)) throw new Error('replica_id_invalid');
	}

	private directory(replicaId: string): string {
		this.assertReplicaId(replicaId);
		return path.join(this.root, replicaId);
	}

	/** Store file for a replica, or undefined when no store is configured. Validated before any fs call. */
	private storeFile(replicaId: string): string | undefined {
		if (!this.stateRoot) return undefined;
		this.assertReplicaId(replicaId);
		const resolvedRoot = path.resolve(this.stateRoot);
		const file = path.resolve(resolvedRoot, `${replicaId}.json`);
		if (path.dirname(file) !== resolvedRoot) throw new Error('replica_id_invalid');
		return file;
	}

	async prepare(replicaId: string): Promise<{ source: string; target: string }> {
		const directory = this.directory(replicaId);
		await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
		await fs.chmod(this.root, 0o700);
		await fs.mkdir(directory, { recursive: true, mode: 0o711 });
		await fs.chmod(directory, 0o711);
		return { source: directory, target: '/run/privos' };
	}

	async register(binding: McpReplicaBinding | McpReplicaBindingV3): Promise<{ source: string; target: string }> {
		if ('protocolVersion' in binding) await this.persistFinalizedV3(binding);
		return this.registerSocket(binding);
	}

	/** Allocate the socket resource early while refusing evidence until final inventory establishment. */
	async registerProvisioningV3(binding: McpProvisioningReplicaBindingV3): Promise<{ source: string; target: string }> {
		return this.registerSocket(binding);
	}

	private async registerSocket(binding: AnyMcpReplicaBinding): Promise<{ source: string; target: string }> {
		await this.close(binding.replicaId);
		const directory = this.directory(binding.replicaId);
		const socketPath = path.join(directory, 'identity.sock');
		// sun_path is 104 bytes on macOS/BSD (108 on Linux); a longer path is
		// silently truncated by bind(), so the server "listens" on a path nobody
		// can mount and the chmod below fails with ENOENT. Fail loudly instead.
		if (Buffer.byteLength(socketPath) >= 104) throw new Error(`broker_socket_path_too_long: ${socketPath}`);
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

	private async persistFinalizedV3(binding: McpReplicaBindingV3): Promise<void> {
		const record: PersistedMcpReplicaBindingV3 = {
			...binding,
			version: 1,
		};
		delete (record as Partial<McpReplicaBindingV3>).dockerContainerId;
		const serialized = `${canonicalJson(record)}\n`;
		// The store is written first so a durable copy exists before the legacy copy
		// (kept for one release so an agent rollback still finds the binding in /run).
		const store = this.storeFile(binding.replicaId);
		if (store) await fs.mkdir(path.dirname(store), { recursive: true, mode: 0o700 });
		const targets = [store, path.join(this.directory(binding.replicaId), 'binding-v3.json')];
		for (const filePath of targets) {
			if (!filePath) continue;
			try {
				const existing = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
				if (canonicalJson(existing) !== canonicalJson(record)) {
					throw new Error('persisted_mcp_v3_broker_binding_conflict');
				}
				continue;
			} catch (error: unknown) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
			await writeFileAtomic(filePath, serialized);
		}
	}

	/**
	 * Read the persisted binding: store first, then the legacy socket-folder copy. Only
	 * the legacy copy is attacker-reachable (the app container mounts that folder), so it
	 * must be a regular file owned by the agent and not accessible to group/other.
	 * A raw ENOENT is returned when neither exists: provisioning registration relies on it.
	 */
	private async readPersistedV3(
		replicaId: string,
	): Promise<{ persisted: Partial<PersistedMcpReplicaBindingV3>; raw: string; fromLegacy: boolean }> {
		const legacyPath = path.join(this.directory(replicaId), 'binding-v3.json');
		const store = this.storeFile(replicaId);
		if (!store) {
			const raw = await fs.readFile(legacyPath, 'utf8');
			return { persisted: JSON.parse(raw), raw, fromLegacy: false };
		}
		try {
			const raw = await fs.readFile(store, 'utf8');
			return { persisted: JSON.parse(raw), raw, fromLegacy: false };
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		let handle: FileHandle;
		try {
			// O_NOFOLLOW refuses a symlink planted in the replica folder.
			handle = await fs.open(legacyPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('persisted_mcp_v3_broker_binding_unsafe');
			throw error;
		}
		try {
			const stat = await handle.stat();
			const uid = process.getuid?.();
			if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
				throw new Error('persisted_mcp_v3_broker_binding_unsafe');
			}
			const raw = await handle.readFile('utf8');
			return { persisted: JSON.parse(raw), raw, fromLegacy: true };
		} finally {
			await handle.close();
		}
	}

	async restoreFinalizedV3(
		labels: Record<string, string>,
		dockerContainerId: string,
	): Promise<void> {
		const replicaId = labels['privos.mcp.replica'];
		if (!replicaId) throw new Error('persisted_mcp_v3_broker_binding_invalid');
		const { persisted, raw, fromLegacy } = await this.readPersistedV3(replicaId);
		const expectedPersistedAffinity: Partial<PersistedMcpReplicaBindingV3> = {
			version: 1,
			protocolVersion: 3,
			clusterId: labels['privos.mcp.cluster'],
			nodeId: labels['privos.mcp.node'],
			workspaceId: labels['privos.mcp.workspace'],
			deploymentId: labels['privos.mcp.deployment'],
			generationId: labels['privos.mcp.generation'],
			generationNumber: Number(labels['privos.mcp.generation-number']),
			runtimeInstallationId: labels['privos.mcp.runtime-installation'],
			mcpAppId: labels['privos.mcp.app'],
			replicaId,
			containerId: labels['privos.id'],
			imageDigest: labels['privos.mcp.image.digest'],
			manifestDigest: labels['privos.mcp.manifest.digest'],
			approvalReceiptHash: labels['privos.mcp.approval-receipt'],
			authorizationEpoch: Number(labels['privos.mcp.authorization-epoch']),
			deploymentGrantHash: labels['privos.mcp.deployment-grant-hash'],
			resourceManifestHash: labels['privos.mcp.resource-manifest-hash'],
			hubOrigin: labels['privos.mcp.hub-origin'],
			hubKid: labels['privos.mcp.hub-kid'],
			networkName: getAppNetworkName(labels['privos.mcp.workspace']),
		};
		if (
			Object.entries(expectedPersistedAffinity).some(([key, value]) =>
				value === undefined || value === '' || Number.isNaN(value) || persisted[key as keyof PersistedMcpReplicaBindingV3] !== value) ||
			typeof persisted.runtimeResourceInventoryHash !== 'string' ||
			!/^[A-Za-z0-9_-]{43}$/.test(persisted.runtimeResourceInventoryHash)
		) throw new Error('persisted_mcp_v3_broker_binding_invalid');
		let hubPublicJwk: JsonWebKey;
		try {
			hubPublicJwk = JSON.parse(labels['privos.mcp.hub-jwk'] ?? '') as JsonWebKey;
		} catch {
			throw new Error('persisted_mcp_v3_broker_binding_invalid');
		}
		// Migrate a validated legacy binding into the store; the legacy copy stays.
		const store = this.storeFile(replicaId);
		if (fromLegacy && store) {
			await fs.mkdir(path.dirname(store), { recursive: true, mode: 0o700 });
			await writeFileAtomic(store, raw);
		}
		await this.register({
			...(expectedPersistedAffinity as Omit<McpReplicaBindingV3, 'dockerContainerId' | 'hubPublicJwk' | 'runtimeResourceInventoryHash'>),
			dockerContainerId,
			hubPublicJwk,
			runtimeResourceInventoryHash: persisted.runtimeResourceInventoryHash,
		});
	}

	async restoreOrRegisterProvisioningV3(
		binding: McpProvisioningReplicaBindingV3,
		labels: Record<string, string>,
	): Promise<void> {
		try {
			await this.restoreFinalizedV3(labels, binding.dockerContainerId);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			await this.registerProvisioningV3(binding);
		}
	}

	private async respond(
		socket: net.Socket,
		binding: AnyMcpReplicaBinding,
		raw: string,
	): Promise<void> {
		try {
			const request = JSON.parse(raw) as unknown;
			if (!isBrokerRequest(request)) throw new Error('broker_request_invalid');
			await this.assertContainerBinding(binding);
			const now = Math.floor(Date.now() / 1000);
			let attestationPayload: Record<string, unknown>;
			if ('protocolVersion' in binding) {
				if (!binding.runtimeResourceInventoryHash) throw new Error('runtime_inventory_not_established');
				attestationPayload = {
					protocolVersion: 3,
					type: 'node-workload-attestation',
					iss: `urn:privos:cluster-node:${binding.clusterId}:${binding.nodeId}`,
					aud: 'privos-hub-api',
					iat: now,
					exp: now + 45,
					jti: crypto.randomUUID(),
					clusterId: binding.clusterId,
					nodeId: binding.nodeId,
					workspaceId: binding.workspaceId,
					deploymentId: binding.deploymentId,
					generationId: binding.generationId,
					generationNumber: binding.generationNumber,
					runtimeInstallationId: binding.runtimeInstallationId,
					mcpAppId: binding.mcpAppId,
					replicaId: binding.replicaId,
					containerId: binding.containerId,
					imageDigest: binding.imageDigest,
					manifestDigest: binding.manifestDigest,
					approvalReceiptHash: binding.approvalReceiptHash,
					authorizationEpoch: binding.authorizationEpoch,
					resourceManifestHash: binding.resourceManifestHash,
					runtimeResourceInventoryHash: binding.runtimeResourceInventoryHash,
					dpopJkt: jwkThumbprint(request.publicJwk),
					nonce: request.nonce,
				};
			} else {
				attestationPayload = {
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
				};
			}
			const attestation = await this.identity.sign(
				attestationPayload,
				'privos-node-attestation+jws',
				'protocolVersion' in binding ? 3 : undefined,
			);
			socket.end(`${JSON.stringify({
				ok: true,
				attestation,
				hubOrigin: binding.hubOrigin,
				hubKid: binding.hubKid,
				hubPublicJwk: binding.hubPublicJwk,
			})}\n`);
			recordClusterMcpEvent({
				event: 'broker_attestation',
				outcome: 'allowed',
				boundary: 'unix_socket',
				reason: 'issued',
				correlationId: 'protocolVersion' in binding ? binding.runtimeInstallationId : binding.installationId,
				emitLog: false,
			});
		} catch (error: unknown) {
			const code = clusterMcpSafeReason(error, 'broker_request_failed');
			recordClusterMcpEvent({
				event: 'broker_attestation',
				outcome: 'denied',
				boundary: 'unix_socket',
				reason: code,
				correlationId: 'protocolVersion' in binding ? binding.runtimeInstallationId : binding.installationId,
			});
			socket.end(`${JSON.stringify({ ok: false, error: code })}\n`);
		}
	}

	private async assertContainerBinding(binding: AnyMcpReplicaBinding): Promise<void> {
		const info = await this.inspectContainer(binding.dockerContainerId);
		if (!info?.State?.Running) throw new Error('container_not_running');
		const labels = (info.Config?.Labels ?? {}) as Record<string, string>;
		const expected: Record<string, string> = 'protocolVersion' in binding ? {
			'privos.workspace': binding.workspaceId,
			'privos.id': binding.containerId,
			'privos.mcp.schema': '3',
			'privos.mcp.runtime-installation': binding.runtimeInstallationId,
			'privos.mcp.generation': binding.generationId,
			'privos.mcp.replica': binding.replicaId,
			'privos.mcp.image.digest': binding.imageDigest,
			'privos.mcp.manifest.digest': binding.manifestDigest,
			'privos.mcp.approval-receipt': binding.approvalReceiptHash,
			'privos.mcp.authorization-epoch': String(binding.authorizationEpoch),
			'privos.mcp.deployment-grant-hash': binding.deploymentGrantHash,
			'privos.mcp.resource-manifest-hash': binding.resourceManifestHash,
			'privos.mcp.hub-kid': binding.hubKid,
		} : {
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
		const store = this.storeFile(replicaId);
		if (store) await fs.rm(store, { force: true });
	}

	/**
	 * Remove store files (and interrupted-write leftovers) whose replica has no container.
	 * Returns the removed file names. Entries that are not store files are left alone.
	 */
	async sweepOrphanStore(knownReplicaIds: ReadonlySet<string>): Promise<string[]> {
		if (!this.stateRoot) return [];
		let entries: string[];
		try {
			entries = await fs.readdir(this.stateRoot);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
		const removed: string[] = [];
		for (const entry of entries) {
			const match = /^([0-9a-f-]{36})\.json(\.next-.+)?$/i.exec(entry);
			if (!match || (!match[2] && knownReplicaIds.has(match[1]!))) continue;
			await fs.rm(path.join(this.stateRoot, entry), { force: true });
			removed.push(entry);
		}
		return removed;
	}

	/** True while a broker socket for this replica is still live and bindable. */
	isBound(replicaId: string): boolean {
		return this.servers.has(replicaId);
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.servers.keys()].map((replicaId) => this.close(replicaId)));
	}
}

/** Temp file, fsync, rename, fsync of the directory: the file is either absent or complete after a crash. */
async function writeFileAtomic(filePath: string, data: string): Promise<void> {
	const temporaryPath = `${filePath}.next-${process.pid}-${crypto.randomUUID()}`;
	try {
		const handle = await fs.open(temporaryPath, 'wx', 0o600);
		try {
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporaryPath, filePath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true });
		throw error;
	}
	const directory = await fs.open(path.dirname(filePath), 'r');
	try {
		await directory.sync();
	} finally {
		await directory.close();
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
	// Only a fleet node reboots with tenants on it; local runtimes keep the socket folder as the only home.
	config.FLEET_MODE ? config.MCP_BROKER_STATE_ROOT : undefined,
);

/** Drops store files whose replica has no managed container (any state). Run once at start-up, before listening. */
export async function sweepOrphanBrokerState(): Promise<string[]> {
	const known = new Set<string>();
	for (const listed of await containerManager.listMcpContainers()) {
		const replicaId = listed.Labels?.['privos.mcp.replica'];
		if (replicaId) known.add(replicaId);
	}
	return mcpBrokerManager.sweepOrphanStore(known);
}

export async function rebindMcpBrokers(): Promise<{ rebound: number; failed: number }> {
	let rebound = 0;
	let failed = 0;
	for (const listed of await containerManager.listMcpContainers()) {
		try {
			const info = await containerManager.inspectContainer(listed.Id);
			const labels = (info.Config?.Labels ?? {}) as Record<string, string>;
			if (labels['privos.mcp.schema'] === '3') {
				if (config.APP_CLUSTER_MCP_INSTALL_V3 === 'on') {
					await mcpBrokerManager.restoreFinalizedV3(labels, listed.Id);
					rebound += 1;
				}
				continue;
			}
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
