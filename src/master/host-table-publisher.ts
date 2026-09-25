import type { JsonWebKey } from 'node:crypto';
import type { AgentClient } from './agent-client.js';
import type { MasterRepositories } from './repositories.js';
import type { MasterApp, MasterNode } from './types.js';

export interface MasterMetaRecord {
	_id: string;
	revision: number;
	updatedAt: Date;
}

const ROUTING_REVISION_ID = 'routing-revision';
/** First retry backoff on a failed push. Doubles per attempt, capped at `MAX_BACKOFF_MS`. */
const BASE_BACKOFF_MS = 3_000;
/** Caps the retry backoff at the same cadence as `master-entry.ts`'s periodic
 * resync timer (5 minutes) — a persistently failing node (e.g. an un-rolled
 * gen node returning 404 during a staged rollout) is retried at most that
 * often, never hot-looped. */
const MAX_BACKOFF_MS = 5 * 60 * 1000;

interface RuntimeTableEntry {
	appId: string;
	workspaceId: string;
	containerId: string;
	hosts: string[];
}

interface IngressRule {
	host: string;
	appId: string;
	workspaceId: string;
	/** Mesh IPs of the RUNTIME nodes currently hosting this app. */
	nodes: string[];
	suspended: boolean;
}

interface IngressSigningKey {
	nodeId: string;
	kid: string;
	publicJwk: JsonWebKey;
}

interface HostTableSnapshot {
	apps: MasterApp[];
	runtimeNodes: MasterNode[];
	ingressNodes: MasterNode[];
	rules: IngressRule[];
	signingKeys: IngressSigningKey[];
}

/**
 * The one global routing-table publisher (F).
 *
 * MULTI-MASTER IS A REAL FLEET SHAPE, not a hypothetical: control nodes run
 * HA (ctl-eu-01/02/03), and control vs. gen nodes deploy separately and
 * non-atomically, so more than one master process CAN be live and pushing at
 * once during a rollout. What makes ordering correct anyway is that every
 * control node shares the SAME `MASTER_MONGODB_URL` — `apps_master_meta` is
 * one collection, not one per process — so `findOneAndUpdate($inc)` on
 * `revision` is globally atomic and monotonic across every writer, with no
 * leader election needed. A node therefore accepts a push if and only if
 * `candidate.revision > stored.revision`; there is no secondary tiebreak,
 * because none is needed or safe — see `bootTimestamp` below.
 *
 * `bootTimestamp` (wall-clock ms at construction) is carried for
 * OBSERVABILITY ONLY (which process's boot produced a given push) and MUST
 * NEVER gate acceptance: unlike `revision`, it is process-local and never
 * reset in shared storage, so ordering by it would let a delayed push from
 * an OLDER boot with a HIGHER `revision` — or vice versa — be accepted or
 * rejected for the wrong reason. `revision` alone is both necessary and
 * sufficient.
 *
 * Callers only ever call `markDirty()`. The publish itself is single-flight
 * (one in-flight pass at a time) and coalescing (every `markDirty()` that
 * lands while a pass is running is satisfied by that pass re-checking `dirty`
 * before it stops, not by queuing a second pass) — so N calls collapse into
 * at most 2 full snapshots (the one already running, plus one more). Every
 * pass reads the FULL current state fresh from Mongo rather than an
 * in-memory diff, so a host can never be dropped by an update ordering race;
 * the only failure mode is "publish this snapshot again later", never
 * "publish an incomplete one".
 *
 * A failed push retries the SAME snapshot and the SAME `revision` — via
 * exponential backoff capped at `MAX_BACKOFF_MS` — rather than re-querying
 * and re-incrementing on every attempt: during a staged rollout, every
 * un-rolled gen node 404s the fleet-wide push forever until it rolls, and
 * that must never turn into a full-scan+push+`$inc` every few seconds. A
 * fresh `markDirty()` arriving mid-retry abandons the stale attempt so the
 * next pass takes a genuinely new snapshot instead of piling retries on top
 * of stale data.
 */
export class HostTablePublisher {
	private readonly bootTimestamp = Date.now();
	private dirty = false;
	private pumping = false;

	constructor(private readonly deps: {
		repositories: MasterRepositories;
		agentClient: AgentClient;
		baseDomain: string;
		log?: { error: (o: unknown, m?: string) => void };
		/** Injectable for tests; real backoff sleeps otherwise. */
		sleep?: (ms: number) => Promise<void>;
	}) {}

	/** Mark the table dirty and kick the pump. Fire-and-forget — never throws, never awaited by the caller. */
	markDirty(): void {
		this.dirty = true;
		void this.pump();
	}

	private async pump(): Promise<void> {
		if (this.pumping) return;
		this.pumping = true;
		try {
			while (this.dirty) {
				this.dirty = false;
				await this.publishWithRetry();
			}
		} finally {
			this.pumping = false;
		}
	}

	/**
	 * One distinct snapshot (one `revision`), retried with exponential backoff
	 * until it succeeds or a newer `markDirty()` supersedes it. Never takes a
	 * second `revision` for a retry of the same, unchanged snapshot.
	 */
	private async publishWithRetry(): Promise<void> {
		const revision = await this.nextRevision();
		const snapshot = await this.buildSnapshot();
		for (let attempt = 0; ; attempt += 1) {
			try {
				await this.pushSnapshot(snapshot, revision);
				return;
			} catch (error) {
				this.deps.log?.error({ err: error, revision, attempt }, 'host-table publish failed; retrying with backoff');
				// A newer change already arrived: abandon this stale attempt so the
				// outer pump loop takes a fresh snapshot+revision for it, rather than
				// keep retrying data that is no longer current.
				if (this.dirty) return;
				await this.sleep(Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt));
			}
		}
	}

	private async sleep(ms: number): Promise<void> {
		await (this.deps.sleep ?? ((delay: number) => new Promise((resolve) => setTimeout(resolve, delay))))(ms);
	}

	/** Taken BEFORE the snapshot query, so a write landing between this increment and the query below is guaranteed its own later publish. */
	private async nextRevision(): Promise<number> {
		const result = await this.deps.repositories.masterMeta.findOneAndUpdate(
			{ _id: ROUTING_REVISION_ID },
			{ $inc: { revision: 1 }, $set: { updatedAt: new Date() } },
			{ upsert: true, returnDocument: 'after' },
		);
		return result?.revision ?? 1;
	}

	private async buildSnapshot(): Promise<HostTableSnapshot> {
		const [apps, nodes, hosts] = await Promise.all([
			this.deps.repositories.apps.find({ state: { $in: ['RUNNING', 'QUARANTINED', 'STOPPED'] } }).toArray(),
			this.deps.repositories.nodes.find({ status: 'ACTIVE' }).toArray(),
			this.deps.repositories.appHosts.find({
				state: { $in: ['PENDING', 'ACTIVE', 'SUSPENDED', 'WS_SUSPENDED'] },
			}).toArray(),
		]);
		// A node registered before public-hostnames rolled has no `role` at all
		// — treated as RUNTIME, byte-identical to what every node in the fleet
		// already does today.
		const runtimeNodes = nodes.filter((node) => !node.role || node.role === 'RUNTIME' || node.role === 'BOTH');
		const ingressNodes = nodes.filter((node) => node.role === 'INGRESS' || node.role === 'BOTH');

		const hostsByApp = new Map<string, typeof hosts>();
		for (const host of hosts) hostsByApp.set(host.appId, [...(hostsByApp.get(host.appId) ?? []), host]);

		const signingKeys: IngressSigningKey[] = runtimeNodes.flatMap((node) =>
			node.mcpIdentityKid && node.mcpIdentityPublicJwk
				? [{ nodeId: node.nodeId, kid: node.mcpIdentityKid, publicJwk: node.mcpIdentityPublicJwk }]
				: []);

		const rules: IngressRule[] = [];
		for (const app of apps) {
			const meshIps = [...new Set(
				app.replicas
					.map((replica) => runtimeNodes.find((node) => node.nodeId === replica.nodeId)?.meshIp)
					.filter((value): value is string => Boolean(value)),
			)];
			const suspended = app.state !== 'RUNNING';
			const appHostRows = hostsByApp.get(app.appId) ?? [];
			if (appHostRows.length > 0) {
				for (const host of appHostRows) {
					rules.push({
						host: host._id,
						appId: app.appId,
						workspaceId: app.workspaceId,
						nodes: meshIps,
						suspended: suspended || host.state === 'WS_SUSPENDED' || host.state === 'SUSPENDED',
					});
				}
				continue;
			}
			// A raw/mcp-v2 app (or a v3 app installed before D-registry rows
			// existed) has no `app_hosts` row at all — fall back to its own
			// default label so it still routes.
			if (app.subdomain) {
				rules.push({
					host: `${app.subdomain}.${this.deps.baseDomain}`,
					appId: app.appId,
					workspaceId: app.workspaceId,
					nodes: meshIps,
					suspended,
				});
			}
		}
		return { apps, runtimeNodes, ingressNodes, rules, signingKeys };
	}

	/** A single, non-retrying attempt: takes a fresh revision + snapshot and pushes once. Used directly by tests and available for a manual/forced publish. */
	async publishOnce(): Promise<{ revision: number; runtimeNodes: number; ingressNodes: number }> {
		const revision = await this.nextRevision();
		const snapshot = await this.buildSnapshot();
		await this.pushSnapshot(snapshot, revision);
		return { revision, runtimeNodes: snapshot.runtimeNodes.length, ingressNodes: snapshot.ingressNodes.length };
	}

	/** Runtime tables first, then ingress: an ingress node must never learn a route before the runtime node behind it has the container to serve it. */
	private async pushSnapshot(snapshot: HostTableSnapshot, revision: number): Promise<void> {
		const runtimeResults = await Promise.allSettled(
			snapshot.runtimeNodes.map((node) => this.pushRuntimeTable(node, snapshot.apps, revision)),
		);
		const ingressResults = await Promise.allSettled(
			snapshot.ingressNodes.map((node) => this.pushIngressTable(node, snapshot.rules, snapshot.signingKeys, revision)),
		);
		const failed = [...runtimeResults, ...ingressResults].filter((result) => result.status === 'rejected');
		if (failed.length > 0) {
			throw new Error(`host-table push failed on ${failed.length}/${snapshot.runtimeNodes.length + snapshot.ingressNodes.length} node(s)`);
		}
	}

	private async pushRuntimeTable(node: MasterNode, apps: MasterApp[], revision: number): Promise<void> {
		const entries: RuntimeTableEntry[] = [];
		for (const app of apps) {
			for (const replica of app.replicas) {
				if (replica.nodeId !== node.nodeId) continue;
				entries.push({
					appId: app.appId,
					workspaceId: app.workspaceId,
					containerId: replica.containerId,
					hosts: app.subdomain ? [app.subdomain] : [],
				});
			}
		}
		const response = await this.deps.agentClient.fleetRequest(node, 'PUT', '/api/v1/fleet/host-table/runtime', {
			bootTimestamp: this.bootTimestamp,
			revision,
			apps: entries,
		});
		if (response.status >= 300) throw new Error(`runtime host-table push to ${node.nodeId} returned ${response.status}`);
	}

	private async pushIngressTable(
		node: MasterNode,
		rules: IngressRule[],
		signingKeys: IngressSigningKey[],
		revision: number,
	): Promise<void> {
		const response = await this.deps.agentClient.fleetRequest(node, 'PUT', '/api/v1/fleet/host-table/ingress', {
			bootTimestamp: this.bootTimestamp,
			revision,
			rules,
			signingKeys,
		});
		if (response.status >= 300) throw new Error(`ingress host-table push to ${node.nodeId} returned ${response.status}`);
	}
}
