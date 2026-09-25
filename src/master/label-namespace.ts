import type { MasterRepositories } from './repositories.js';

/**
 * One label namespace, shared by every host kind (legacy random labels, D1
 * TENANT, VANITY) and by every allocator (the random `SubdomainRegistry`, the
 * D10 hostname registry). `_id` is the label itself (the first DNS component,
 * before `.privos.link`), so a single unique index across the whole
 * collection IS the namespace lock — two callers racing for the same label
 * can never both win.
 *
 * A label is never deleted once claimed (D10: tombstones are keyed to
 * `(workspaceId, listingId)` forever). `release()` moves it to RECLAIMED
 * (platform-owned, blocklisted for a fresh allocation) instead — an admin can
 * explicitly `reassign()` it back to HELD, which is the only path that ever
 * lets a label be reused.
 */
export interface HostLabelRecord {
	_id: string;
	state: 'HELD' | 'RECLAIMED';
	/** Present while HELD; cleared (not overwritten with garbage) on release. */
	workspaceId?: string;
	listingId?: string;
	createdAt: Date;
	updatedAt: Date;
}

const LABEL_ALREADY_CLAIMED = 'LABEL_ALREADY_CLAIMED';

export class LabelNamespace {
	constructor(private readonly repositories: MasterRepositories) {}

	/** True when `label` has never been claimed and is not RECLAIMED (blocklisted). */
	async isAvailable(label: string): Promise<boolean> {
		const existing = await this.repositories.hostLabels.findOne({ _id: label });
		return existing === null;
	}

	/**
	 * Same check, but a label the CALLER's own workspace already holds also
	 * reads as available — a workspace re-checking its own current label (or a
	 * label a sibling app of theirs pre-registered) must not see it reported
	 * taken. Used by the Hub-facing `subdomain-check` route, which is scoped
	 * to the caller's own workspace rather than a global existence probe.
	 */
	async isAvailableFor(label: string, workspaceId: string): Promise<boolean> {
		const existing = await this.repositories.hostLabels.findOne({ _id: label });
		if (!existing) return true;
		return existing.state === 'HELD' && existing.workspaceId === workspaceId;
	}

	/** Atomically claim `label` for `owner`. Throws `LABEL_ALREADY_CLAIMED` (HELD or RECLAIMED) on conflict. */
	async hold(label: string, owner: { workspaceId: string; listingId: string }): Promise<void> {
		const now = new Date();
		try {
			await this.repositories.hostLabels.insertOne({
				_id: label,
				state: 'HELD',
				workspaceId: owner.workspaceId,
				listingId: owner.listingId,
				createdAt: now,
				updatedAt: now,
			});
		} catch (error: unknown) {
			if ((error as { code?: number }).code !== 11000) throw error;
			throw Object.assign(new Error(`label_already_claimed: ${label}`), { code: LABEL_ALREADY_CLAIMED });
		}
	}

	/** Free `label` for its current owner. Tombstones it as RECLAIMED rather than deleting the row (D10). */
	async release(label: string): Promise<void> {
		await this.repositories.hostLabels.updateOne(
			{ _id: label },
			{ $set: { state: 'RECLAIMED', updatedAt: new Date() }, $unset: { workspaceId: '', listingId: '' } },
		);
	}

	/** Admin-only: move a RECLAIMED (platform-owned) label back to HELD under a new owner. */
	async reassign(label: string, owner: { workspaceId: string; listingId: string }): Promise<void> {
		const now = new Date();
		const result = await this.repositories.hostLabels.updateOne(
			{ _id: label, state: 'RECLAIMED' },
			{ $set: { state: 'HELD', workspaceId: owner.workspaceId, listingId: owner.listingId, updatedAt: now } },
		);
		if (result.matchedCount !== 1) throw Object.assign(new Error(`label_not_reclaimed: ${label}`), { code: 'LABEL_NOT_RECLAIMED' });
	}

	/**
	 * Generate candidates from `next(attempt)` until one claims cleanly.
	 * ponytail: bounded retry (not an infinite loop) — 10 attempts matches the
	 * pre-existing SubdomainRegistry behaviour this replaces.
	 */
	async allocate(
		next: (attempt: number) => string,
		owner: { workspaceId: string; listingId: string },
		maxAttempts = 10,
	): Promise<string> {
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const label = next(attempt);
			try {
				await this.hold(label, owner);
				return label;
			} catch (error) {
				if ((error as { code?: string }).code !== LABEL_ALREADY_CLAIMED) throw error;
			}
		}
		throw new Error('unable to allocate unique label');
	}
}
