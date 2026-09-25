import type { MasterRepositories } from './repositories.js';
import type { LabelNamespace } from './label-namespace.js';
import type { WorkspaceLock } from './workspace-lock.js';
import type { HostTablePublisher } from './host-table-publisher.js';
import type { CfCustomHostnameWorker } from './cf-custom-hostname-worker.js';

export type AppHostKind = 'TENANT' | 'VANITY' | 'CUSTOM';
/**
 * PENDING/ACTIVE/SUSPENDED/FAILED/DELETING are the phase-3 spec's own states.
 * WS_SUSPENDED and CF_RELEASED implement D19 (workspace power/expiry): a host
 * WS_SUSPENDED leaves the routing tables but keeps its label and CF hostname;
 * CF_RELEASED additionally has no CF custom hostname left (30-day retention
 * job), and resume re-creates it through the async CF worker.
 */
export type AppHostState = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'WS_SUSPENDED' | 'CF_RELEASED' | 'FAILED' | 'DELETING';

export interface AppHostRecord {
	/** The full public hostname (e.g. `app--acme.privos.link` or the operator's own `app.customer.com`). */
	_id: string;
	workspaceId: string;
	appId: string;
	listingId: string;
	/** Absent for a pre-registered row (portal-known appId, no generation yet) and for raw/mcp-v2 apps. */
	generationId?: string;
	kind: AppHostKind;
	primary: boolean;
	state: AppHostState;
	cfHostnameId?: string;
	lastError?: string;
	/** Set on the WS_SUSPENDED transition; drives the 30-day CF-release job. Cleared on resume. */
	wsSuspendedAt?: Date;
	/**
	 * M3: the state this row held immediately before a workspace suspend swept
	 * it to WS_SUSPENDED — `PENDING` | `ACTIVE` | `SUSPENDED`. Resume restores
	 * EXACTLY this value, never a hardcoded `ACTIVE`, so a per-host admin
	 * SUSPENDED (set via the PUT hosts route) survives a suspend→resume cycle
	 * instead of silently reactivating. Absent on a row suspended before this
	 * field existed — resume falls back to `ACTIVE` for those, unchanged from
	 * pre-fix behaviour.
	 */
	preSuspendState?: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
	createdAt: Date;
	updatedAt: Date;
}

export interface DesiredAppHost {
	hostname: string;
	kind: AppHostKind;
	primary: boolean;
	state: 'ACTIVE' | 'SUSPENDED';
}

/** The first DNS label owns a namespace slot; a CUSTOM hostname lives on the
 * operator's own domain and never touches the shared privos.link namespace. */
function namespaceLabelOf(hostname: string, kind: AppHostKind): string | undefined {
	return kind === 'CUSTOM' ? undefined : hostname.split('.')[0];
}

/**
 * D + E: the public-hostname registry (`app_hosts`, `_id` = hostname).
 *
 * Pre-registration (D): a row may exist — via `reserve` — before the app row
 * itself does, because the Portal knows the `appId` before install. The v3
 * env builder (`DeploymentService.platformEnvVarsV3`) reads the current
 * primary from here, not from `MasterApp.subdomain`, whenever a registry is
 * wired in.
 */
export class AppHostRegistry {
	constructor(private readonly deps: {
		repositories: MasterRepositories;
		namespace: LabelNamespace;
		locks: WorkspaceLock;
		cfWorker?: CfCustomHostnameWorker;
		publisher?: HostTablePublisher;
	}) {}

	/** Synchronous reserve: a label check + hold, so a conflict is reported before anything else is written. */
	async reserve(input: {
		workspaceId: string;
		appId: string;
		listingId: string;
		hostname: string;
		kind: AppHostKind;
	}): Promise<AppHostRecord> {
		return this.deps.locks.run(input.workspaceId, async () => {
			const existing = await this.deps.repositories.appHosts.findOne({ _id: input.hostname });
			if (existing) {
				if (existing.workspaceId === input.workspaceId && existing.appId === input.appId) return existing;
				throw Object.assign(new Error(`host_already_reserved: ${input.hostname}`), { code: 'HOST_ALREADY_RESERVED', statusCode: 409 });
			}
			const label = namespaceLabelOf(input.hostname, input.kind);
			if (label) {
				try {
					await this.deps.namespace.hold(label, { workspaceId: input.workspaceId, listingId: input.listingId });
				} catch (error) {
					if ((error as { code?: string }).code !== 'LABEL_ALREADY_CLAIMED') throw error;
					// L7: self-healing retry. We already confirmed above that NO
					// `app_hosts` row exists for this exact hostname, so if the label
					// conflict is because THIS workspace already holds it, the most
					// likely explanation is a prior `reserve()` that held the label
					// but crashed/lost its write before the `insertOne` below — not a
					// genuine conflict. Proceed rather than wedge the rightful owner
					// behind a 409 forever; a truly foreign owner still gets refused.
					const ownedByCaller = await this.deps.namespace.isAvailableFor(label, input.workspaceId);
					if (!ownedByCaller) {
						throw Object.assign(new Error(`label_already_claimed: ${label}`), { code: 'LABEL_ALREADY_CLAIMED', statusCode: 409 });
					}
				}
			}
			const now = new Date();
			const row: AppHostRecord = {
				_id: input.hostname,
				workspaceId: input.workspaceId,
				appId: input.appId,
				listingId: input.listingId,
				kind: input.kind,
				primary: false,
				state: 'PENDING',
				createdAt: now,
				updatedAt: now,
			};
			// L6: a CUSTOM hostname holds no label (`namespaceLabelOf` above is a
			// no-op for it — the operator's own domain, never the shared
			// namespace), so the unique `_id` index on `app_hosts` itself is the
			// ONLY thing that catches two workspaces racing to reserve the exact
			// same CUSTOM hostname concurrently. A raw driver E11000 must never
			// reach the route as a bare `{error: 11000}` — map it to the same
			// coded 409 a label conflict already produces.
			try {
				await this.deps.repositories.appHosts.insertOne(row);
			} catch (error) {
				if ((error as { code?: number }).code !== 11000) throw error;
				throw Object.assign(
					new Error(`host_conflict: ${input.hostname}`),
					{ code: 'HOST_CONFLICT', statusCode: 409, hostname: input.hostname },
				);
			}
			return row;
		});
	}

	/**
	 * The full desired set for one app (PUT semantics). Rows are written under
	 * `locks.run(workspaceId)`; the CF create/delete that a row transition may
	 * need runs in the async worker, outside this lock and outside this call's
	 * own await chain, so a slow/failing Cloudflare call never blocks the ack.
	 */
	async setDesiredHosts(input: {
		workspaceId: string;
		appId: string;
		listingId: string;
		generationId?: string;
		hosts: DesiredAppHost[];
	}): Promise<AppHostRecord[]> {
		if (input.hosts.filter((host) => host.primary).length > 1) {
			throw Object.assign(new Error('multiple_primary_hosts'), { code: 'MULTIPLE_PRIMARY_HOSTS', statusCode: 400 });
		}
		const rows = await this.deps.locks.run(input.workspaceId, async () => {
			const current = await this.deps.repositories.appHosts.find({
				workspaceId: input.workspaceId,
				appId: input.appId,
				state: { $ne: 'DELETING' },
			}).toArray();
			const desired = new Set(input.hosts.map((host) => host.hostname));
			const now = new Date();
			const written: AppHostRecord[] = [];
			for (const host of input.hosts) {
				const existing = current.find((row) => row._id === host.hostname);
				if (existing) {
					const next: Partial<AppHostRecord> = {
						primary: host.primary,
						state: host.state,
						generationId: input.generationId,
						updatedAt: now,
					};
					await this.deps.repositories.appHosts.updateOne({ _id: host.hostname }, { $set: next });
					written.push({ ...existing, ...next });
					continue;
				}
				// A brand-new row: hold its label (a no-op collision when this same
				// app already pre-registered it via `reserve`, since `hold` is keyed
				// per label and this app already owns it there is nothing to race).
				const label = namespaceLabelOf(host.hostname, host.kind);
				if (label) {
					try {
						await this.deps.namespace.hold(label, { workspaceId: input.workspaceId, listingId: input.listingId });
					} catch (error) {
						if ((error as { code?: string }).code !== 'LABEL_ALREADY_CLAIMED') throw error;
						throw Object.assign(
							new Error(`host_conflict: ${host.hostname}`),
							{ code: 'HOST_CONFLICT', statusCode: 409, hostname: host.hostname },
						);
					}
				}
				const row: AppHostRecord = {
					_id: host.hostname,
					workspaceId: input.workspaceId,
					appId: input.appId,
					listingId: input.listingId,
					generationId: input.generationId,
					kind: host.kind,
					primary: host.primary,
					state: 'PENDING',
					createdAt: now,
					updatedAt: now,
				};
				// L6: same CUSTOM cross-workspace race as `reserve` — map a raw
				// E11000 to the coded 409 instead of letting it escape.
				try {
					await this.deps.repositories.appHosts.insertOne(row);
				} catch (error) {
					if ((error as { code?: number }).code !== 11000) throw error;
					throw Object.assign(
						new Error(`host_conflict: ${host.hostname}`),
						{ code: 'HOST_CONFLICT', statusCode: 409, hostname: host.hostname },
					);
				}
				written.push(row);
			}
			// Anything currently on the app but no longer in the desired set moves
			// to DELETING; its CF hostname (if any) is torn down by the async worker.
			const removed = current.filter((row) => !desired.has(row._id));
			for (const row of removed) {
				await this.deps.repositories.appHosts.updateOne({ _id: row._id }, { $set: { state: 'DELETING', updatedAt: now } });
			}
			return [...written, ...removed.map((row) => ({ ...row, state: 'DELETING' as const, updatedAt: now }))];
		});
		this.deps.publisher?.markDirty();
		this.deps.cfWorker?.notify();
		return rows;
	}

	async get(workspaceId: string, appId: string): Promise<AppHostRecord[]> {
		return this.deps.repositories.appHosts.find({ workspaceId, appId }).toArray();
	}

	/** The primary ACTIVE host of an app, if any — what the v3 env builder reads. */
	async primaryOf(workspaceId: string, appId: string): Promise<AppHostRecord | null> {
		return this.deps.repositories.appHosts.findOne({
			workspaceId,
			appId,
			primary: true,
			state: { $in: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
		});
	}

	/**
	 * E: its own uninstall step, run for whatever the inventory actually
	 * contains. Idempotent, and scoped to `generationId` when given — a
	 * reinstall of the same `appId` under a NEW generation must keep the hosts
	 * that new generation registered, never sweep them up as leftovers of the
	 * old one. Raw/mcp-v2 offboard has no generation concept and passes none,
	 * which tears down every row for the app.
	 */
	async removeAllAppHosts(appId: string, generationId?: string): Promise<number> {
		const filter = generationId ? { appId, generationId } : { appId };
		const now = new Date();
		const result = await this.deps.repositories.appHosts.updateMany(
			{ ...filter, state: { $ne: 'DELETING' } },
			{ $set: { state: 'DELETING', updatedAt: now } },
		);
		if (result.modifiedCount > 0) {
			this.deps.publisher?.markDirty();
			this.deps.cfWorker?.notify();
		}
		return result.modifiedCount;
	}

	/**
	 * D19: workspace power. Suspend leaves the label and CF hostname untouched
	 * and only pulls the host out of the routing tables (`WS_SUSPENDED`);
	 * resume restores it instantly. Neither path is a teardown — see
	 * `removeAllAppHosts` for that.
	 */
	/**
	 * M3: a per-host admin SUSPENDED (set via `PUT .../hosts`) must survive a
	 * workspace suspend→resume cycle — resume must never silently reactivate a
	 * host an admin deliberately suspended. Each source state is swept with
	 * its OWN `updateMany` (rather than one query + a pipeline update) so
	 * `preSuspendState` records exactly which state each row came from, and
	 * resume restores exactly that value — never a hardcoded `ACTIVE`.
	 */
	async setWorkspaceHostsSuspended(workspaceId: string, suspended: boolean): Promise<number> {
		const now = new Date();
		let modified = 0;
		if (suspended) {
			for (const from of ['PENDING', 'ACTIVE', 'SUSPENDED'] as const) {
				const result = await this.deps.repositories.appHosts.updateMany(
					{ workspaceId, state: from },
					{ $set: { state: 'WS_SUSPENDED', preSuspendState: from, wsSuspendedAt: now, updatedAt: now } },
				);
				modified += result.modifiedCount;
			}
		} else {
			for (const to of ['PENDING', 'ACTIVE', 'SUSPENDED'] as const) {
				const result = await this.deps.repositories.appHosts.updateMany(
					{ workspaceId, state: { $in: ['WS_SUSPENDED', 'CF_RELEASED'] }, preSuspendState: to },
					{ $set: { state: to, updatedAt: now }, $unset: { wsSuspendedAt: '', preSuspendState: '' } },
				);
				modified += result.modifiedCount;
			}
			// A row suspended before `preSuspendState` existed carries no such
			// field — falls back to the pre-fix behaviour (ACTIVE) rather than
			// being stranded WS_SUSPENDED forever.
			const fallback = await this.deps.repositories.appHosts.updateMany(
				{ workspaceId, state: { $in: ['WS_SUSPENDED', 'CF_RELEASED'] }, preSuspendState: { $exists: false } },
				{ $set: { state: 'ACTIVE', updatedAt: now }, $unset: { wsSuspendedAt: '' } },
			);
			modified += fallback.modifiedCount;
		}
		if (modified > 0) {
			this.deps.publisher?.markDirty();
			// A resumed host may have had its CF custom hostname released by the
			// retention job; the worker re-creates it if `cfHostnameId` is absent.
			if (!suspended) this.deps.cfWorker?.notify();
		}
		return modified;
	}

	/**
	 * D19 daily job target list: a WS_SUSPENDED CUSTOM host past its retention
	 * window. Marking + the actual Cloudflare delete happen in the async CF
	 * worker (`releaseSuspendedCfHostnames`), never here — this method only
	 * finds candidates.
	 */
	async findSuspendedHostsPastCfRetention(retentionDays: number, now = new Date()): Promise<AppHostRecord[]> {
		const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
		return this.deps.repositories.appHosts.find({
			state: 'WS_SUSPENDED',
			kind: 'CUSTOM',
			cfHostnameId: { $type: 'string' },
			wsSuspendedAt: { $lte: cutoff },
		}).toArray();
	}
}
