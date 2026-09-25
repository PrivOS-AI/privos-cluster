import type { MasterRepositories } from './repositories.js';
import type { AppHostRecord } from './app-host-registry.js';

interface CloudflareEnvelope<T> {
	success: boolean;
	result: T;
	errors?: Array<{ message: string; code?: number }>;
}

interface CfCustomHostname {
	id: string;
	hostname: string;
	custom_metadata?: Record<string, string>;
}

/**
 * M4: every custom hostname WE create is tagged with its own registry `_id`
 * (the hostname string) under this key, so a later pass can tell "this is
 * OUR object, just a lost post-create DB write" apart from "a truly foreign
 * object with the same hostname" — the tag survives on Cloudflare's side even
 * when our own `cfHostnameId` write never lands.
 */
const REGISTRY_TAG_KEY = 'privos_registry_id';

/**
 * Cloudflare-for-SaaS custom-hostname lifecycle for CUSTOM (operator-owned
 * domain) hosts, run entirely off the request path (D: "CF create/delete
 * runs in an async worker outside the lock, with 429/5xx backoff").
 *
 * Deliberately its own token (`CF_APPS_SAAS_API_TOKEN`) — separate from
 * `IngressRouteProgrammer`'s `CF_APPS_API_TOKEN`, which only ever manages
 * wildcard/CNAME DNS on the privos.link zone. Least privilege: a leak of one
 * can never touch the other's surface.
 */
export class CfCustomHostnameWorker {
	private running = false;
	private pending = false;

	constructor(private readonly deps: {
		repositories: MasterRepositories;
		enabled: boolean;
		zoneId?: string;
		apiToken?: string;
		/** Injectable for tests; real backoff sleeps otherwise. */
		sleep?: (ms: number) => Promise<void>;
	}) {}

	/** Mark work pending and kick the pump. Never awaited by a caller — CF work must never block the request path. */
	notify(): void {
		this.pending = true;
		void this.pump();
	}

	/** Single-flight: a `notify()` that lands mid-run is picked up by the loop, not by a second concurrent pump. */
	private async pump(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			while (this.pending) {
				this.pending = false;
				try {
					await this.runOnce();
				} catch {
					// A whole-pass failure (e.g. Cloudflare unreachable) re-arms `pending`
					// so the next notify()/tick retries; it never throws out of a
					// fire-and-forget call.
					this.pending = true;
					await this.sleep(5_000);
				}
			}
		} finally {
			this.running = false;
		}
	}

	/** One pass: create every PENDING CUSTOM host missing a CF hostname, delete every DELETING one that still has one. */
	async runOnce(): Promise<{ created: number; deleted: number }> {
		if (!this.deps.enabled || !this.deps.zoneId || !this.deps.apiToken) return { created: 0, deleted: 0 };
		const toCreate = await this.deps.repositories.appHosts.find({
			kind: 'CUSTOM',
			state: { $in: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
			cfHostnameId: { $exists: false },
		}).toArray();
		const toDelete = await this.deps.repositories.appHosts.find({
			kind: 'CUSTOM',
			state: 'DELETING',
			cfHostnameId: { $type: 'string' },
		}).toArray();
		let created = 0;
		let deleted = 0;
		for (const host of toCreate) {
			if (await this.create(host)) created += 1;
		}
		for (const host of toDelete) {
			if (await this.delete(host)) deleted += 1;
		}
		return { created, deleted };
	}

	/** D19 daily job: delete the CF custom hostname of every WS_SUSPENDED CUSTOM host past `retentionDays`, mark it CF_RELEASED. */
	async releaseSuspendedCfHostnames(retentionDays: number, now = new Date()): Promise<{ released: number }> {
		if (!this.deps.enabled || !this.deps.zoneId || !this.deps.apiToken) return { released: 0 };
		const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
		const candidates = await this.deps.repositories.appHosts.find({
			state: 'WS_SUSPENDED',
			kind: 'CUSTOM',
			cfHostnameId: { $type: 'string' },
			wsSuspendedAt: { $lte: cutoff },
		}).toArray();
		let released = 0;
		for (const host of candidates) {
			try {
				if (host.cfHostnameId) await this.api(`/custom_hostnames/${host.cfHostnameId}`, 'DELETE');
				await this.deps.repositories.appHosts.updateOne(
					{ _id: host._id, state: 'WS_SUSPENDED' },
					{ $set: { state: 'CF_RELEASED', updatedAt: new Date() }, $unset: { cfHostnameId: '' } },
				);
				released += 1;
			} catch (error) {
				await this.deps.repositories.appHosts.updateOne(
					{ _id: host._id },
					{ $set: { lastError: this.errorMessage(error), updatedAt: new Date() } },
				);
			}
		}
		return { released };
	}

	private async create(host: AppHostRecord): Promise<boolean> {
		try {
			const existing = await this.findExisting(host._id);
			if (existing) {
				if (existing.custom_metadata?.[REGISTRY_TAG_KEY] === host._id) {
					// M4: ours — a prior create call succeeded on Cloudflare but the
					// `cfHostnameId` write to Mongo never landed (a crash or a lost
					// write between the two). The tag was set AT CREATION TIME and
					// lives on Cloudflare's side, so it survives that lost write; adopt
					// the object instead of treating our own repair as a conflict.
					await this.deps.repositories.appHosts.updateOne(
						{ _id: host._id },
						{ $set: { cfHostnameId: existing.id, state: host.state === 'PENDING' ? 'ACTIVE' : host.state, updatedAt: new Date() }, $unset: { lastError: '' } },
					);
					return true;
				}
				// Never adopt a hostname this registry did not create: a foreign
				// custom-hostname object for the same string (a different Cloudflare
				// account/zone config, or a stale object CF never told us about) must
				// fail loud rather than silently start routing under someone else's
				// TLS/verification state.
				await this.deps.repositories.appHosts.updateOne(
					{ _id: host._id },
					{ $set: { state: 'FAILED', lastError: 'hostname_exists_elsewhere', updatedAt: new Date() } },
				);
				return false;
			}
			const created = await this.api<CfCustomHostname>('/custom_hostnames', 'POST', {
				hostname: host._id,
				ssl: { method: 'http', type: 'dv' },
				custom_metadata: { [REGISTRY_TAG_KEY]: host._id },
			});
			await this.deps.repositories.appHosts.updateOne(
				{ _id: host._id },
				{ $set: { cfHostnameId: created.id, state: host.state === 'PENDING' ? 'ACTIVE' : host.state, updatedAt: new Date() }, $unset: { lastError: '' } },
			);
			return true;
		} catch (error) {
			await this.deps.repositories.appHosts.updateOne(
				{ _id: host._id },
				{ $set: { lastError: this.errorMessage(error), updatedAt: new Date() } },
			);
			return false;
		}
	}

	private async delete(host: AppHostRecord): Promise<boolean> {
		try {
			if (host.cfHostnameId) await this.api(`/custom_hostnames/${host.cfHostnameId}`, 'DELETE');
			await this.deps.repositories.appHosts.deleteOne({ _id: host._id, state: 'DELETING' });
			return true;
		} catch (error) {
			await this.deps.repositories.appHosts.updateOne(
				{ _id: host._id },
				{ $set: { lastError: this.errorMessage(error), updatedAt: new Date() } },
			);
			return false;
		}
	}

	private async findExisting(hostname: string): Promise<CfCustomHostname | undefined> {
		const results = await this.api<CfCustomHostname[]>(`/custom_hostnames?hostname=${encodeURIComponent(hostname)}`);
		return results[0];
	}

	private errorMessage(error: unknown): string {
		return (error instanceof Error ? error.message : String(error)).slice(0, 500);
	}

	private async sleep(ms: number): Promise<void> {
		await (this.deps.sleep ?? ((delay: number) => new Promise((resolve) => setTimeout(resolve, delay))))(ms);
	}

	/**
	 * ponytail: fixed 5-attempt exponential backoff (500ms base) on 429/5xx,
	 * not a token-bucket rate limiter — Cloudflare's custom-hostname volume
	 * here is low (one call per host transition), so this is proportionate.
	 * Upgrade to a shared rate limiter if the fleet starts bulk-provisioning
	 * hundreds of CUSTOM hosts at once.
	 */
	private async api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${this.deps.zoneId}${path}`, {
					method,
					headers: {
						authorization: `Bearer ${this.deps.apiToken}`,
						'content-type': 'application/json',
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.timeout(15_000),
				});
				if (response.status === 429 || response.status >= 500) {
					lastError = new Error(`Cloudflare API returned ${response.status}`);
					await this.sleep(500 * 2 ** attempt);
					continue;
				}
				const envelope = await response.json() as CloudflareEnvelope<T>;
				if (!response.ok || !envelope.success) {
					throw new Error(envelope.errors?.map((error) => error.message).join('; ') || 'Cloudflare API failed');
				}
				return envelope.result;
			} catch (error) {
				lastError = error;
				if (attempt < 4) await this.sleep(500 * 2 ** attempt);
			}
		}
		throw lastError instanceof Error ? lastError : new Error('Cloudflare API failed after retries');
	}
}
