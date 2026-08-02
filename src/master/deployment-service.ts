import crypto from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { z } from 'zod';
import type { MasterRepositories } from './repositories.js';
import type { AvailabilityTier, MasterApp, MasterNode } from './types.js';
import { AgentClient } from './agent-client.js';
import { IngressRouteProgrammer } from './ingress-route-programmer.js';
import { QuotaService } from './quota-service.js';
import { selectNodes, type NodeReservation, SchedulingError } from './scheduler.js';
import { SubdomainRegistry } from './subdomain-registry.js';
import { WorkspaceLock } from './workspace-lock.js';
import type { McpDeploymentGrantPayload } from './mcp-security.js';
import { jwkThumbprint } from '../security/artifacts.js';

const DeploySchema = z.object({
	appId: z.string().min(1).max(128).optional(),
	listingId: z.string().min(1).max(128),
	versionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	image: z.string().min(1),
	digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	tag: z.string().default('latest'),
	port: z.number().int().min(1).max(65535).default(3001),
	resources: z.object({
		memoryMb: z.number().int().min(64).max(16384),
		cpus: z.number().min(0.1).max(16),
		tmpSizeMb: z.number().int().min(16).max(4096).default(64),
	}),
	envVars: z.record(z.string(), z.string()).default({}),
	volumes: z.array(z.object({
		name: z.literal('data'),
		mountPath: z.string().startsWith('/'),
		sizeMb: z.number().int().positive().optional(),
	})).max(1).default([]),
	availabilityTier: z.enum(['single', 'ha']).default('single'),
	stateless: z.boolean().default(false),
});

export class DeploymentService {
	constructor(private readonly deps: {
		repositories: MasterRepositories;
		agentClient: AgentClient;
		ingress: IngressRouteProgrammer;
		quota: QuotaService;
		subdomains: SubdomainRegistry;
		locks: WorkspaceLock;
		baseDomain: string;
	}) {}

	async deploy(workspaceId: string, raw: unknown): Promise<MasterApp> {
		const input = DeploySchema.parse(raw);
		return this.deps.locks.run(workspaceId, async () => {
			if (input.appId) {
				const existing = await this.deps.repositories.apps.findOne({
					workspaceId,
					$or: [{ appId: input.appId }, { listingId: input.listingId }],
					state: { $ne: 'REMOVED' },
				});
				if (existing) return existing;
			}
			if (input.availabilityTier === 'ha' && !input.stateless) {
				const error: Error & { code?: string } = new Error('stateful apps cannot run in HA');
				error.code = 'HA_REQUIRES_STATELESS_APP';
				throw error;
			}
			const replicaCount = input.availabilityTier === 'ha' ? 2 : 1;
			await this.deps.quota.assertDeployAllowed(workspaceId, input.resources, replicaCount);
			const [nodes, existingApps] = await Promise.all([
				this.deps.repositories.nodes.find({ status: 'ACTIVE' }).toArray(),
				this.deps.repositories.apps.find({ state: 'RUNNING' }).toArray(),
			]);
			const reservations: NodeReservation[] = existingApps.flatMap((app) =>
				app.replicas.map((replica) => ({
					nodeId: replica.nodeId,
					memoryMb: app.resources.memoryMb,
					cpus: app.resources.cpus,
					diskBytes: (app as MasterApp & { storageBytes?: number }).storageBytes ?? 0,
				})),
			);
			const storageBytes = (input.volumes[0]?.sizeMb ?? 0) * 1024 * 1024;
			const selected = selectNodes({
				nodes,
				reservations,
				resources: input.resources,
				storageBytes,
				replicas: replicaCount,
			});
			return this.deployToNodes(workspaceId, input, selected);
		});
	}

	async deployMcp(
		workspaceId: string,
		grant: McpDeploymentGrantPayload,
		deploymentGrantHash: string,
		hubIdentity: { kid: string; publicJwk: JsonWebKey },
	): Promise<MasterApp> {
		const input = DeploySchema.parse({
			appId: grant.deployment.appId,
			listingId: grant.deployment.listingId,
			versionDigest: grant.deployment.versionDigest,
			image: grant.deployment.image,
			digest: grant.deployment.imageDigest,
			tag: 'latest',
			port: grant.deployment.port,
			resources: grant.deployment.resources,
			envVars: grant.deployment.envVars,
			volumes: grant.deployment.volumes,
			availabilityTier: grant.deployment.availabilityTier,
			stateless: grant.deployment.stateless,
		});
		return this.deps.locks.run(workspaceId, async () => {
			const existing = await this.deps.repositories.apps.findOne({
				workspaceId,
				mcpInstallationId: grant.installationId,
				state: { $ne: 'REMOVED' },
			});
			if (existing) {
				if (
					existing.imageDigest !== grant.deployment.imageDigest ||
					existing.manifestDigest !== grant.deployment.manifestDigest ||
					existing.receiptHash !== grant.receiptHash ||
					existing.grantEpoch !== grant.grantEpoch
				) {
					throw new Error('existing_mcp_installation_binding_mismatch');
				}
				return existing;
			}
			if (input.availabilityTier === 'ha' && !input.stateless) throw Object.assign(new Error('stateful apps cannot run in HA'), { code: 'HA_REQUIRES_STATELESS_APP' });
			const replicaCount = input.availabilityTier === 'ha' ? 2 : 1;
			await this.deps.quota.assertDeployAllowed(workspaceId, input.resources, replicaCount);
			const [nodes, existingApps] = await Promise.all([
				this.deps.repositories.nodes.find({ status: 'ACTIVE' }).toArray(),
				this.deps.repositories.apps.find({ state: 'RUNNING' }).toArray(),
			]);
			const reservations: NodeReservation[] = existingApps.flatMap((app) =>
				app.replicas.map((replica) => ({
					nodeId: replica.nodeId,
					memoryMb: app.resources.memoryMb,
					cpus: app.resources.cpus,
					diskBytes: app.storageBytes ?? 0,
				})),
			);
			const selected = selectNodes({
				nodes,
				reservations,
				resources: input.resources,
				storageBytes: (input.volumes[0]?.sizeMb ?? 0) * 1024 * 1024,
				replicas: replicaCount,
			});
			return this.deployMcpToNodes(workspaceId, input, grant, deploymentGrantHash, hubIdentity, selected);
		});
	}

	private async deployMcpToNodes(
		workspaceId: string,
		input: z.infer<typeof DeploySchema>,
		grant: McpDeploymentGrantPayload,
		deploymentGrantHash: string,
		hubIdentity: { kid: string; publicJwk: JsonWebKey },
		nodes: MasterNode[],
	): Promise<MasterApp> {
		const appId = input.appId!;
		const storageBytes = (input.volumes[0]?.sizeMb ?? 0) * 1024 * 1024;
		const subdomain = grant.deployment.subdomain ?? await this.deps.subdomains.allocate(input.listingId);
		const replicas = [];
		try {
			for (const node of nodes) {
				const replicaId = crypto.randomUUID();
				const response = await this.deps.agentClient.request(node, workspaceId, 'POST', '/api/v1/mcp/apps/deploy', {
					...input,
					appId,
					workspaceId,
					subdomain,
					domain: this.deps.baseDomain,
					mcpBinding: {
						clusterId: grant.clusterId,
						nodeId: node.nodeId,
						workspaceId,
						installationId: grant.installationId,
						mcpAppId: grant.mcpAppId,
						replicaId,
						imageDigest: grant.deployment.imageDigest,
						manifestDigest: grant.deployment.manifestDigest,
						receiptHash: grant.receiptHash,
						grantEpoch: grant.grantEpoch,
						deploymentGrantHash,
						hubOrigin: grant.hubOrigin,
						hubKid: hubIdentity.kid,
						hubPublicJwk: hubIdentity.publicJwk,
					},
				});
				if (response.status >= 300) throw new Error(`agent MCP deploy failed: ${JSON.stringify(response.body)}`);
				const container = response.body as {
					id: string;
					state: string;
					nodeIdentity: { nodeId: string; kid: string; publicJwk: JsonWebKey };
				};
				if (
					container.nodeIdentity?.nodeId !== node.nodeId ||
					jwkThumbprint(container.nodeIdentity.publicJwk) !== container.nodeIdentity.kid
				) {
					throw new Error('agent_node_identity_invalid');
				}
				await this.deps.repositories.nodes.updateOne(
					{ nodeId: node.nodeId },
					{ $set: { mcpIdentityKid: container.nodeIdentity.kid, mcpIdentityPublicJwk: container.nodeIdentity.publicJwk, updatedAt: new Date() } },
				);
				replicas.push({
					replicaId,
					nodeId: node.nodeId,
					containerId: container.id,
					state: container.state,
					mcpNodeIdentity: { kid: container.nodeIdentity.kid, publicJwk: container.nodeIdentity.publicJwk },
				});
			}
		} catch (error) {
			await Promise.allSettled(replicas.map((replica) => {
				const node = nodes.find((candidate) => candidate.nodeId === replica.nodeId)!;
				return this.deps.agentClient.request(node, workspaceId, 'DELETE', `/api/v1/apps/${replica.containerId}`);
			}));
			throw error;
		}
		const now = new Date();
		const app: MasterApp = {
			appId,
			workspaceId,
			listingId: input.listingId,
			versionDigest: input.versionDigest,
			image: input.image,
			imageDigest: input.digest,
			resources: input.resources,
			port: input.port,
			envVars: input.envVars,
			volumes: input.volumes,
			storageBytes,
			availabilityTier: input.availabilityTier as AvailabilityTier,
			stateless: input.stateless,
			subdomain,
			uiUrl: `https://${subdomain}.${this.deps.baseDomain}`,
			replicas,
			state: 'QUARANTINED',
			kind: 'mcp-v2',
			mcpInstallationId: grant.installationId,
			mcpAppId: grant.mcpAppId,
			manifestDigest: grant.deployment.manifestDigest,
			receiptHash: grant.receiptHash,
			grantEpoch: grant.grantEpoch,
			createdAt: now,
			updatedAt: now,
		};
		await this.deps.repositories.apps.insertOne(app);
		await this.deps.repositories.lifecycleEvents.insertMany(replicas.map((replica) => ({
			eventId: crypto.randomUUID(), workspaceId, appId, replicaId: replica.replicaId,
			type: 'STARTED' as const, resources: input.resources, storageBytes, at: now,
		})));
		return app;
	}

	async activateMcp(workspaceId: string, input: {
		installationId: string;
		receiptHash: string;
		grantEpoch: number;
	}): Promise<MasterApp> {
		return this.deps.locks.run(workspaceId, async () => {
			const app = await this.deps.repositories.apps.findOne({ workspaceId, mcpInstallationId: input.installationId, kind: 'mcp-v2' });
			if (!app) throw Object.assign(new Error('MCP app not found'), { statusCode: 404 });
			if (app.receiptHash !== input.receiptHash || app.grantEpoch !== input.grantEpoch) throw new Error('mcp_activation_binding_mismatch');
			if (app.state === 'RUNNING') return app;
			if (app.state !== 'QUARANTINED') throw new Error('mcp_app_not_quarantined');
			const nodes = await this.deps.repositories.nodes.find({ nodeId: { $in: app.replicas.map((replica) => replica.nodeId) } }).toArray();
			if (nodes.length !== app.replicas.length) throw new Error('mcp_replica_node_missing');
			await this.deps.ingress.upsert(app.subdomain, nodes);
			await this.deps.repositories.apps.updateOne(
				{ appId: app.appId, state: 'QUARANTINED' },
				{ $set: { state: 'RUNNING', updatedAt: new Date() } },
			);
			return { ...app, state: 'RUNNING', updatedAt: new Date() };
		});
	}

	private async deployToNodes(
		workspaceId: string,
		input: z.infer<typeof DeploySchema>,
		nodes: MasterNode[],
	): Promise<MasterApp> {
		const appId = input.appId ?? crypto.randomUUID();
		const storageBytes = (input.volumes[0]?.sizeMb ?? 0) * 1024 * 1024;
		const subdomain = await this.deps.subdomains.allocate(input.listingId);
		const replicas = [];
		try {
			for (const node of nodes) {
				const response = await this.deps.agentClient.request(
					node,
					workspaceId,
					'POST',
					'/api/v1/apps/deploy',
					{
						...input,
						appId,
						workspaceId,
						subdomain,
						domain: this.deps.baseDomain,
					},
				);
				if (response.status >= 300) throw new Error(`agent deploy failed: ${JSON.stringify(response.body)}`);
				const container = response.body as { id: string; state: string };
				replicas.push({
					replicaId: crypto.randomUUID(),
					nodeId: node.nodeId,
					containerId: container.id,
					state: container.state,
				});
			}
			await this.deps.ingress.upsert(subdomain, nodes);
		} catch (error) {
			await Promise.allSettled(replicas.map((replica) => {
				const node = nodes.find((candidate) => candidate.nodeId === replica.nodeId)!;
				return this.deps.agentClient.request(
					node,
					workspaceId,
					'DELETE',
					`/api/v1/apps/${replica.containerId}`,
				);
			}));
			throw error;
		}
		const now = new Date();
		const app: MasterApp = {
			appId,
			workspaceId,
			listingId: input.listingId,
			versionDigest: input.versionDigest,
			image: input.image,
			imageDigest: input.digest,
			resources: input.resources,
			port: input.port,
			envVars: input.envVars,
			volumes: input.volumes,
			storageBytes,
			availabilityTier: input.availabilityTier as AvailabilityTier,
			stateless: input.stateless,
			subdomain,
			uiUrl: `https://${subdomain}.${this.deps.baseDomain}`,
			replicas,
			state: 'RUNNING',
			createdAt: now,
			updatedAt: now,
		};
		await this.deps.repositories.apps.insertOne(app);
		await this.deps.repositories.lifecycleEvents.insertMany(replicas.map((replica) => ({
			eventId: crypto.randomUUID(),
			workspaceId,
			appId,
			replicaId: replica.replicaId,
			type: 'STARTED' as const,
			resources: input.resources,
			storageBytes,
			at: now,
		})));
		return app;
	}

	async changeAvailabilityTier(workspaceId: string, appId: string, availabilityTier: AvailabilityTier): Promise<MasterApp> {
		return this.deps.locks.run(workspaceId, async () => {
			const app = await this.deps.repositories.apps.findOne({ workspaceId, appId, state: { $ne: 'REMOVED' } });
			if (!app) {
				const error: Error & { statusCode?: number } = new Error('app not found');
				error.statusCode = 404;
				throw error;
			}
			if (app.kind === 'mcp-v2') {
				throw Object.assign(new Error('MCP availability changes require a new signed deployment grant'), {
					code: 'MCP_SIGNED_REDEPLOYMENT_REQUIRED',
				});
			}
			if (app.availabilityTier === availabilityTier) return app;
			if (app.state !== 'RUNNING') {
				const error: Error & { code?: string } = new Error('app must be running before changing availability tier');
				error.code = 'APP_NOT_RUNNING';
				throw error;
			}
			if (availabilityTier === 'ha') {
				if (!app.stateless) {
					const error: Error & { code?: string } = new Error('stateful apps cannot run in HA');
					error.code = 'HA_REQUIRES_STATELESS_APP';
					throw error;
				}
				await this.deps.quota.assertAdditionalReplicaAllowed(workspaceId, app.resources);
				const [nodes, runningApps] = await Promise.all([
					this.deps.repositories.nodes.find({ status: 'ACTIVE' }).toArray(),
					this.deps.repositories.apps.find({ state: 'RUNNING' }).toArray(),
				]);
				const occupiedNodes = new Set(app.replicas.map((replica) => replica.nodeId));
				const occupiedDomains = new Set(
					nodes.filter((node) => occupiedNodes.has(node.nodeId)).map((node) => node.failureDomain),
				);
				const reservations: NodeReservation[] = runningApps.flatMap((candidate) =>
					candidate.replicas.map((replica) => ({
						nodeId: replica.nodeId,
						memoryMb: candidate.resources.memoryMb,
						cpus: candidate.resources.cpus,
						diskBytes: 0,
					})),
				);
				let node: MasterNode;
				try {
					[node] = selectNodes({
						nodes: nodes.filter((candidate) => !occupiedNodes.has(candidate.nodeId) && !occupiedDomains.has(candidate.failureDomain)),
						reservations,
						resources: app.resources,
						storageBytes: 0,
						replicas: 1,
					});
				} catch {
					const error: Error & { code?: string } = new Error('HA requires a second active app node in a distinct failure domain with capacity');
					error.code = 'HA_CAPACITY_UNAVAILABLE';
					throw error;
				}
				const response = await this.deps.agentClient.request(node, workspaceId, 'POST', '/api/v1/apps/deploy', {
					appId,
					listingId: app.listingId,
					versionDigest: app.versionDigest,
					image: app.image,
					digest: app.imageDigest,
					port: app.port ?? 3001,
					resources: app.resources,
					envVars: app.envVars ?? {},
					volumes: [],
					workspaceId,
					subdomain: app.subdomain,
					domain: this.deps.baseDomain,
				});
				if (response.status >= 300) throw new Error(`agent deploy failed: ${JSON.stringify(response.body)}`);
				const container = response.body as { id: string; state: string };
				const replica = { replicaId: crypto.randomUUID(), nodeId: node.nodeId, containerId: container.id, state: container.state };
				const now = new Date();
				await this.deps.ingress.upsert(app.subdomain, [
					...nodes.filter((candidate) => occupiedNodes.has(candidate.nodeId)),
					node,
				]);
				await this.deps.repositories.apps.updateOne(
					{ workspaceId, appId },
					{ $set: { availabilityTier: 'ha', updatedAt: now }, $push: { replicas: replica } },
				);
				await this.deps.repositories.lifecycleEvents.insertOne({
					eventId: crypto.randomUUID(), workspaceId, appId, replicaId: replica.replicaId,
					type: 'STARTED', resources: app.resources, at: now,
				});
			} else {
				const [keep, ...remove] = app.replicas;
				if (!keep) throw new Error('app has no replicas');
				const nodes = await this.deps.repositories.nodes.find({ nodeId: { $in: app.replicas.map((replica) => replica.nodeId) } }).toArray();
				for (const replica of remove) {
					const node = nodes.find((candidate) => candidate.nodeId === replica.nodeId);
					if (!node) throw new Error(`node not found: ${replica.nodeId}`);
					const response = await this.deps.agentClient.request(node, workspaceId, 'DELETE', `/api/v1/apps/${replica.containerId}`);
					if (response.status >= 300 && response.status !== 404) throw new Error(`agent remove failed: ${JSON.stringify(response.body)}`);
				}
				const now = new Date();
				await this.deps.ingress.upsert(app.subdomain, nodes.filter((node) => node.nodeId === keep.nodeId));
				await this.deps.repositories.apps.updateOne(
					{ workspaceId, appId },
					{ $set: { availabilityTier: 'single', replicas: [keep], updatedAt: now } },
				);
				if (remove.length) {
					await this.deps.repositories.lifecycleEvents.insertMany(remove.map((replica) => ({
						eventId: crypto.randomUUID(), workspaceId, appId, replicaId: replica.replicaId,
						type: 'REMOVED' as const, resources: app.resources, at: now,
					})));
				}
			}
			return this.deps.repositories.apps.findOne({ workspaceId, appId }) as Promise<MasterApp>;
		});
	}
}

export { SchedulingError };
