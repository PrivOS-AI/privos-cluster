import crypto from 'node:crypto';
import type { MasterRepositories } from './repositories.js';
import { AgentClient, type AgentResponse } from './agent-client.js';
import { IngressRouteProgrammer } from './ingress-route-programmer.js';

export class AppLifecycleService {
	constructor(private readonly deps: {
		repositories: MasterRepositories;
		agentClient: AgentClient;
		ingress: IngressRouteProgrammer;
	}) {}

	async list(workspaceId: string): Promise<unknown[]> {
		const apps = await this.deps.repositories.apps
			.find({ workspaceId, state: { $ne: 'REMOVED' } })
			.toArray();
		return apps.map((app) => this.view(app));
	}

	async get(workspaceId: string, appId: string): Promise<unknown> {
		const app = await this.load(workspaceId, appId);
		return this.view(app);
	}

	async invoke(
		workspaceId: string,
		appId: string,
		action: 'start' | 'stop' | 'restart',
	): Promise<unknown> {
		const app = await this.load(workspaceId, appId);
		if (app.kind === 'mcp-v3') {
			throw Object.assign(new Error('MCP v3 lifecycle requires a signed Hub command'), {
				code: 'MCP_SIGNED_LIFECYCLE_REQUIRED',
				statusCode: 409,
			});
		}
		const nodes = await this.loadNodes(app.replicas.map((replica) => replica.nodeId));
		const responses = await Promise.all(app.replicas.map((replica) => {
			const node = nodes.get(replica.nodeId)!;
			return this.deps.agentClient.request(
				node,
				workspaceId,
				'POST',
				`/api/v1/apps/${replica.containerId}/${action}`,
			);
		}));
		this.assertResponses(responses);
		const state = action === 'stop' ? 'STOPPED' : 'RUNNING';
		const now = new Date();
		await this.deps.repositories.apps.updateOne(
			{ appId, workspaceId },
			{ $set: { state, updatedAt: now, 'replicas.$[].state': state.toLowerCase() } },
		);
		if (action !== 'restart') {
			await this.deps.repositories.lifecycleEvents.insertMany(app.replicas.map((replica) => ({
				eventId: crypto.randomUUID(),
				workspaceId,
				appId,
				replicaId: replica.replicaId,
				type: action === 'stop' ? 'STOPPED' as const : 'STARTED' as const,
				resources: app.resources,
				at: now,
			})));
		}
		return this.get(workspaceId, appId);
	}

	/**
	 * Stop or start every app in a workspace because the WORKSPACE's own power
	 * state changed — dunning suspension, offboard, a manual stack stop.
	 *
	 * Deliberately not routed through `invoke`, which refuses `mcp-v3` apps
	 * because their *lifecycle* transitions must carry a signed Hub command.
	 * That rule protects identity and authorization — install, uninstall,
	 * upgrade — and the Hub is the authority for them. Power state is a
	 * different thing: nothing here touches a generation, binding, receipt,
	 * epoch or entitlement, and demanding a signed Hub command would be
	 * unsatisfiable anyway, because the Hub being suspended is the whole reason
	 * we are here.
	 *
	 * Without this, a dunning-suspended tenant left its app containers running
	 * against a dead Hub: permanently unhealthy, still consuming app-node
	 * resources, and polluting the health and dispatch-409 signals that the
	 * release gate now reads.
	 *
	 * Idempotent, and never destructive — no uninstall, no purge.
	 */
	async setWorkspacePower(
		workspaceId: string,
		action: 'suspend' | 'resume',
	): Promise<{ workspaceId: string; action: string; affected: number }> {
		const suspending = action === 'suspend';
		// Suspending takes what is running; resuming takes back only what THIS
		// mechanism stopped, so an app an operator stopped on purpose before the
		// suspension is not silently started by the resume.
		const selector = suspending
			? { workspaceId, state: 'RUNNING' }
			: { workspaceId, state: { $ne: 'REMOVED' }, suspendedWithWorkspace: true };
		const apps = await this.deps.repositories.apps.find(selector).toArray();
		if (apps.length === 0) return { workspaceId, action, affected: 0 };

		const nodes = await this.loadNodes(apps.flatMap((app) => app.replicas.map((replica) => replica.nodeId)));
		const now = new Date();
		for (const app of apps) {
			const responses = await Promise.all(app.replicas.flatMap((replica) => {
				const node = nodes.get(replica.nodeId);
				// A replica whose node is gone has nothing to stop; resuming it is
				// the deployment path's job, not this one's.
				if (!node) return [];
				return [this.deps.agentClient.request(
					node,
					workspaceId,
					'POST',
					`/api/v1/apps/${replica.containerId}/${suspending ? 'stop' : 'start'}`,
				)];
			}));
			this.assertResponses(responses);
			const state = suspending ? 'STOPPED' : 'RUNNING';
			await this.deps.repositories.apps.updateOne(
				{ appId: app.appId, workspaceId },
				{
					$set: {
						state,
						updatedAt: now,
						'replicas.$[].state': state.toLowerCase(),
						...(suspending ? { suspendedWithWorkspace: true } : {}),
					},
					...(suspending ? {} : { $unset: { suspendedWithWorkspace: '' } }),
				},
			);
			await this.deps.repositories.lifecycleEvents.insertMany(app.replicas.map((replica) => ({
				eventId: crypto.randomUUID(),
				workspaceId,
				appId: app.appId,
				replicaId: replica.replicaId,
				type: (suspending ? 'STOPPED' : 'STARTED') as 'STOPPED' | 'STARTED',
				resources: app.resources,
				at: now,
			})));
		}
		return { workspaceId, action, affected: apps.length };
	}

	async redeploy(
		workspaceId: string,
		appId: string,
		input: {
			image?: string;
			digest?: string;
			versionDigest?: string;
			resources?: { memoryMb?: number; cpus?: number; tmpSizeMb?: number };
		},
	): Promise<unknown> {
		const app = await this.load(workspaceId, appId);
		if (app.kind === 'mcp-v2' || app.kind === 'mcp-v3') {
			const error: Error & { code?: string; statusCode?: number } = new Error(
				'MCP redeployments require a new signed deployment grant',
			);
			error.code = 'MCP_SIGNED_REDEPLOYMENT_REQUIRED';
			error.statusCode = 409;
			throw error;
		}
		const nodes = await this.loadNodes(app.replicas.map((replica) => replica.nodeId));
		const body = {
			workspaceId,
			image: input.image ?? app.image,
			digest: input.digest ?? app.imageDigest,
			versionDigest: input.versionDigest ?? app.versionDigest,
			resources: input.resources ?? app.resources,
			rolling: app.stateless,
		};
		const responses = await Promise.all(app.replicas.map((replica) =>
			this.deps.agentClient.request(
				nodes.get(replica.nodeId)!,
				workspaceId,
				'POST',
				`/api/v1/apps/${replica.containerId}/redeploy`,
				body,
			),
		));
		this.assertResponses(responses);
		const now = new Date();
		await this.deps.repositories.apps.updateOne(
			{ appId, workspaceId },
			{
				$set: {
					image: body.image,
					imageDigest: body.digest,
					versionDigest: body.versionDigest,
					resources: { ...app.resources, ...input.resources },
					state: 'RUNNING',
					updatedAt: now,
					'replicas.$[].state': 'running',
				},
			},
		);
		await this.deps.repositories.lifecycleEvents.insertMany(app.replicas.map((replica) => ({
			eventId: crypto.randomUUID(),
			workspaceId,
			appId,
			replicaId: replica.replicaId,
			type: 'REDEPLOYED' as const,
			resources: { ...app.resources, ...input.resources },
			at: now,
		})));
		return this.get(workspaceId, appId);
	}

	async proxy(
		workspaceId: string,
		appId: string,
		method: string,
		suffix: string,
		body?: unknown,
	): Promise<AgentResponse> {
		const app = await this.load(workspaceId, appId);
		const replica = app.replicas[0];
		if (!replica) throw new Error('app has no replicas');
		const nodes = await this.loadNodes([replica.nodeId]);
		return this.deps.agentClient.request(
			nodes.get(replica.nodeId)!,
			workspaceId,
			method,
			`/api/v1/apps/${replica.containerId}${suffix}`,
			body,
		);
	}

	async remove(workspaceId: string, appId: string): Promise<void> {
		const app = await this.load(workspaceId, appId);
		if (app.kind === 'mcp-v3') {
			throw Object.assign(new Error('MCP v3 removal requires a signed Hub lifecycle command'), {
				code: 'MCP_SIGNED_LIFECYCLE_REQUIRED',
				statusCode: 409,
			});
		}
		await this.deps.repositories.apps.updateOne(
			{ appId, workspaceId },
			{ $set: { state: 'REMOVING', updatedAt: new Date() } },
		);
		const nodes = await this.loadNodes(app.replicas.map((replica) => replica.nodeId));
		const responses = await Promise.all(app.replicas.map((replica) =>
			this.deps.agentClient.request(
				nodes.get(replica.nodeId)!,
				workspaceId,
				'DELETE',
				`/api/v1/apps/${replica.containerId}`,
			),
		));
		this.assertResponses(responses);
		await this.deps.ingress.remove(app.subdomain);
		const now = new Date();
		await this.deps.repositories.apps.updateOne(
			{ appId, workspaceId },
			{ $set: { state: 'REMOVED', updatedAt: now } },
		);
		await this.deps.repositories.lifecycleEvents.insertMany(app.replicas.map((replica) => ({
			eventId: crypto.randomUUID(),
			workspaceId,
			appId,
			replicaId: replica.replicaId,
			type: 'REMOVED' as const,
			resources: app.resources,
			at: now,
		})));
	}

	private async load(workspaceId: string, appId: string) {
		const app = await this.deps.repositories.apps.findOne({
			appId,
			workspaceId,
			state: { $ne: 'REMOVED' },
		});
		if (!app) {
			const error: Error & { statusCode?: number } = new Error('app not found');
			error.statusCode = 404;
			throw error;
		}
		return app;
	}

	private async loadNodes(nodeIds: string[]) {
		const nodes = await this.deps.repositories.nodes.find({ nodeId: { $in: nodeIds } }).toArray();
		return new Map(nodes.map((node) => [node.nodeId, node]));
	}

	private assertResponses(responses: AgentResponse[]): void {
		const failed = responses.find((response) => response.status >= 300);
		if (failed) throw new Error(`agent operation failed: ${JSON.stringify(failed.body)}`);
	}

	private view(app: Awaited<ReturnType<AppLifecycleService['load']>>) {
		return {
			id: app.appId,
			appId: app.appId,
			listingId: app.listingId,
			versionDigest: app.versionDigest,
			state: app.state.toLowerCase(),
			resources: app.resources,
			subdomain: app.subdomain,
			domain: new URL(app.uiUrl).hostname.split('.').slice(1).join('.'),
			uiUrl: app.uiUrl,
			availabilityTier: app.availabilityTier,
			...(app.kind === 'mcp-v3'
				? { replicaCount: app.replicas.length }
				: { replicas: app.replicas }),
			createdAt: app.createdAt.getTime(),
		};
	}
}
