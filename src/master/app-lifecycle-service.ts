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
			replicas: app.replicas,
			createdAt: app.createdAt.getTime(),
		};
	}
}
