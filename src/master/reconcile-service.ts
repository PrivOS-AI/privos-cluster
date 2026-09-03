import crypto from 'node:crypto';
import type { MasterRepositories } from './repositories.js';
import type { AgentClient } from './agent-client.js';
import type { MasterApp } from './types.js';
import type { Container } from '../types/index.js';

export class ReconcileService {
	constructor(private readonly deps: {
		repositories: MasterRepositories;
		agentClient: AgentClient;
		baseDomain: string;
	}) {}

	async run(): Promise<{ discovered: number; repaired: number; failed: number }> {
		const [workspaces, nodes] = await Promise.all([
			this.deps.repositories.workspaces.find({ status: 'ACTIVE' }, { projection: { workspaceId: 1 } }).toArray(),
			this.deps.repositories.nodes.find({ status: { $ne: 'RETIRED' } }).toArray(),
		]);
		let discovered = 0;
		let repaired = 0;
		let failed = 0;
		for (const workspace of workspaces) {
			for (const node of nodes) {
				try {
					const response = await this.deps.agentClient.request(
						node,
						workspace.workspaceId,
						'GET',
						'/api/v1/apps',
					);
					if (response.status >= 300) throw new Error(`agent returned ${response.status}`);
					for (const container of response.body as Container[]) {
						discovered += 1;
						repaired += await this.reconcileContainer(workspace.workspaceId, node.nodeId, container);
					}
				} catch {
					failed += 1;
				}
			}
		}
		return { discovered, repaired, failed };
	}

	private async reconcileContainer(
		workspaceId: string,
		nodeId: string,
		container: Container,
	): Promise<number> {
		const appId = container.appId ?? container.id;
		const app = await this.deps.repositories.apps.findOne({ appId, workspaceId });
		// A QUARANTINED app is intentionally stopped, pending reap after the grace
		// window — its stopped container is NOT drift. Never touch it here (in
		// particular, never overwrite QUARANTINED with the container's state, which
		// would hide it from the reaper and strand the workload forever).
		if (app?.state === 'QUARANTINED') return 0;
		// V3 recovery must resume from its persisted generation plan and exact
		// inventory. Generic discovery must never invent a replica or mark it RUNNING.
		if (container.mcpV3 || app?.kind === 'mcp-v3') return 0;
		if (app) {
			if (app.replicas.some((replica) => replica.containerId === container.id)) return 0;
			await this.deps.repositories.apps.updateOne(
				{ appId, workspaceId },
				{
					$push: {
						replicas: {
							replicaId: crypto.randomUUID(),
							nodeId,
							containerId: container.id,
							state: container.state,
						},
					},
					$set: { state: container.state.toUpperCase(), updatedAt: new Date() },
				},
			);
			await this.seedLifecycle(workspaceId, appId, nodeId, container);
			return 1;
		}
		if (!container.listingId || !container.versionDigest || !container.imageDigest || !container.subdomain) {
			return 0;
		}
		const now = new Date();
		const reconstructed: MasterApp = {
			appId,
			workspaceId,
			listingId: container.listingId,
			versionDigest: container.versionDigest,
			image: container.image,
			imageDigest: container.imageDigest,
			resources: container.resources,
			port: container.port,
			envVars: container.envVars,
			volumes: container.volumes.map((volume) => ({
				name: 'data' as const,
				mountPath: volume.mountPath,
				sizeMb: volume.sizeMb,
			})),
			storageBytes: container.volumes.reduce((sum, volume) => sum + (volume.sizeMb ?? 0) * 1024 * 1024, 0),
			availabilityTier: 'single',
			stateless: container.volumes.length === 0,
			subdomain: container.subdomain,
			uiUrl: `https://${container.subdomain}.${this.deps.baseDomain}`,
			replicas: [{
				replicaId: crypto.randomUUID(),
				nodeId,
				containerId: container.id,
				state: container.state,
			}],
			state: container.state.toUpperCase(),
			createdAt: new Date(container.createdAt),
			updatedAt: now,
		};
		await this.deps.repositories.apps.updateOne(
			{ appId, workspaceId },
			{ $setOnInsert: reconstructed },
			{ upsert: true },
		);
		await this.seedLifecycle(workspaceId, appId, nodeId, container);
		return 1;
	}

	private async seedLifecycle(
		workspaceId: string,
		appId: string,
		nodeId: string,
		container: Container,
	): Promise<void> {
		if (container.state !== 'running') return;
		const eventId = `reconcile:${nodeId}:${container.id}:${container.createdAt}`;
		await this.deps.repositories.lifecycleEvents.updateOne(
			{ eventId },
			{
				$setOnInsert: {
					eventId,
					workspaceId,
					appId,
					replicaId: container.id,
					type: 'STARTED',
					resources: container.resources,
					at: new Date(container.createdAt),
				},
			},
			{ upsert: true },
		);
	}
}
