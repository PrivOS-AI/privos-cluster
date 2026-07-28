import type { MasterNode } from './types.js';

interface CloudflareEnvelope<T> {
	success: boolean;
	result: T;
	errors?: Array<{ message: string }>;
}

export function resolveIngressTunnelId(nodes: MasterNode[], haTunnelId?: string): string | undefined {
	if (haTunnelId) return haTunnelId;
	const nodeTunnelIds = [...new Set(nodes.map((node) => node.tunnelId).filter((value): value is string => Boolean(value)))];
	return nodeTunnelIds.length === 1 ? nodeTunnelIds[0] : undefined;
}

export class IngressRouteProgrammer {
	constructor(private readonly options: {
		enabled: boolean;
		zoneId?: string;
		apiToken?: string;
		baseDomain: string;
	}) {}

	async upsert(subdomain: string, nodes: MasterNode[], haTunnelId?: string): Promise<void> {
		if (!this.options.enabled) return;
		const tunnelId = resolveIngressTunnelId(nodes, haTunnelId);
		if (!tunnelId) {
			const error: Error & { code?: string } = new Error(
				nodes.length > 1
					? 'HA ingress requires a dedicated tunnel replicated on every hosting node'
					: 'hosting node has no Cloudflare tunnel id',
			);
			error.code = nodes.length > 1 ? 'HA_INGRESS_UNCONFIGURED' : 'INGRESS_UNCONFIGURED';
			throw error;
		}
		const name = `${subdomain}.${this.options.baseDomain}`;
		const existing = await this.api<Array<{ id: string }>>(
			`/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
		);
		const payload = {
			type: 'CNAME',
			name,
			content: `${tunnelId}.cfargotunnel.com`,
			proxied: true,
			ttl: 1,
		};
		if (existing[0]?.id) {
			await this.api(`/dns_records/${existing[0].id}`, 'PUT', payload);
		} else {
			await this.api('/dns_records', 'POST', payload);
		}
	}

	async remove(subdomain: string): Promise<void> {
		if (!this.options.enabled) return;
		const name = `${subdomain}.${this.options.baseDomain}`;
		const records = await this.api<Array<{ id: string }>>(
			`/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
		);
		await Promise.all(records.map((record) => this.api(`/dns_records/${record.id}`, 'DELETE')));
	}

	private async api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/zones/${this.options.zoneId}${path}`,
			{
				method,
				headers: {
					authorization: `Bearer ${this.options.apiToken}`,
					'content-type': 'application/json',
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(15_000),
			},
		);
		const envelope = await response.json() as CloudflareEnvelope<T>;
		if (!response.ok || !envelope.success) {
			throw new Error(envelope.errors?.map((error) => error.message).join('; ') || 'Cloudflare API failed');
		}
		return envelope.result;
	}
}
