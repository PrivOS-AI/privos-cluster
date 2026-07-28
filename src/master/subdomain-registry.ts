import crypto from 'node:crypto';
import type { MasterRepositories } from './repositories.js';

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 48) || 'app';
}

export class SubdomainRegistry {
	constructor(private readonly repositories: MasterRepositories) {}

	async allocate(listingId: string): Promise<string> {
		for (let attempt = 0; attempt < 10; attempt += 1) {
			const candidate = `${slug(listingId)}-${crypto.randomBytes(3).toString('hex')}`;
			const exists = await this.repositories.apps.findOne({ subdomain: candidate });
			if (!exists) return candidate;
		}
		throw new Error('unable to allocate unique app hostname');
	}
}
