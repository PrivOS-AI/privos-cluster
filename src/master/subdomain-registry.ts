import crypto from 'node:crypto';
import type { MasterRepositories } from './repositories.js';
import { LabelNamespace } from './label-namespace.js';

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 48) || 'app';
}

/**
 * The legacy random-label allocator. Now backed by the shared D10 namespace
 * (`LabelNamespace`/`host_labels`) instead of a raw `apps.subdomain`
 * existence check, so a legacy label, a TENANT label and a VANITY label can
 * never collide with each other — same namespace, one unique index.
 */
export class SubdomainRegistry {
	private readonly namespace: LabelNamespace;

	constructor(repositories: MasterRepositories) {
		this.namespace = new LabelNamespace(repositories);
	}

	async allocate(listingId: string, workspaceId: string): Promise<string> {
		return this.namespace.allocate(
			() => `${slug(listingId)}-${crypto.randomBytes(3).toString('hex')}`,
			{ workspaceId, listingId },
		);
	}
}
