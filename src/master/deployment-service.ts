import crypto from 'node:crypto';
import { z } from 'zod';
import type { MasterRepositories } from './repositories.js';
import type { AvailabilityTier, MasterApp, MasterNode } from './types.js';
import { AgentClient } from './agent-client.js';
import { IngressRouteProgrammer } from './ingress-route-programmer.js';
import { QuotaService } from './quota-service.js';
import { selectNodes, type NodeReservation, SchedulingError } from './scheduler.js';
import { SubdomainRegistry } from './subdomain-registry.js';
import { WorkspaceLock } from './workspace-lock.js';

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
					appId: input.appId,
					workspaceId,
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

	private async deployToNodes(
		workspaceId: string,
		input: z.infer<typeof DeploySchema>,
		nodes: MasterNode[],
	): Promise<MasterApp> {
		const appId = input.appId ?? crypto.randomUUID();
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
			at: now,
		})));
		return app;
	}
}

export { SchedulingError };
