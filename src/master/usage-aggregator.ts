import type { AppLifecycleEvent, AppUsageDaily, MasterApp } from './types.js';
import type { MasterRepositories } from './repositories.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const GIB = 1024 ** 3;

export function utcDay(value: Date | string): Date {
	const date = new Date(value);
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addCompute(
	target: { ramGbHours: number; cpuHours: number },
	resources: AppLifecycleEvent['resources'],
	durationMs: number,
) {
	if (durationMs <= 0) return;
	target.ramGbHours += (resources.memoryMb / 1024) * (durationMs / HOUR_MS);
	target.cpuHours += resources.cpus * (durationMs / HOUR_MS);
}

/** App-level events never represent one replica's start/stop, so they never
 * enter the per-replica ops-metrics integration below. */
const APP_LEVEL_ONLY_TYPES = new Set<AppLifecycleEvent['type']>(['INSTALLED', 'UNINSTALLED', 'REPLICAS_CHANGED', 'RESIZED']);

/** Events that participate in the per-app BILLABLE INTERVAL: the app-level
 * events plus the revoke-teardown QUARANTINED (which also closes an interval).
 * The pre-activation QUARANTINED *state* every MCP deploy passes through never
 * reaches this list — it is a field on the app document, not an emitted
 * lifecycle event (see deployMcpV3's finalize step), so there is no ambiguity
 * between the two meanings of "QUARANTINED" here. */
const BILLING_INTERVAL_TYPES = new Set<AppLifecycleEvent['type']>([...APP_LEVEL_ONLY_TYPES, 'QUARANTINED']);

type PerAppRow = AppUsageDaily['perApp'][number];

interface OpenInterval {
	since: number;
	resources: AppLifecycleEvent['resources'];
	replicaCount: number;
	storageBytes?: number;
}

export function aggregateWorkspaceDay(
	workspaceId: string,
	date: Date,
	events: AppLifecycleEvent[],
	apps: MasterApp[],
	asOf = new Date(utcDay(date).getTime() + DAY_MS),
): AppUsageDaily {
	const start = utcDay(date);
	const end = new Date(start.getTime() + DAY_MS);
	const accountingEnd = Math.min(end.getTime(), Math.max(start.getTime(), asOf.getTime()));

	const perApp = new Map<string, PerAppRow>();
	const appUsage = (appId: string): PerAppRow => {
		const existing = perApp.get(appId);
		if (existing) return existing;
		const created: PerAppRow = {
			appId,
			ramGbHours: 0,
			cpuHours: 0,
			storageGbDay: 0,
			resources: { memoryMb: 0, cpus: 0 },
			replicaCount: 0,
			installedDayFraction: 0,
		};
		perApp.set(appId, created);
		return created;
	};

	// --- Ops metrics (ramGbHours/cpuHours): per-REPLICA STARTED/STOPPED/REDEPLOYED
	// integration. Unchanged in spirit from before per-app billing intervals
	// existed — these numbers are operational telemetry, not what is billed.
	const running = new Map<string, { appId: string; resources: AppLifecycleEvent['resources']; since: number }>();
	const integrate = (key: string, until: number) => {
		const interval = running.get(key);
		if (!interval) return;
		addCompute(appUsage(interval.appId), interval.resources, Math.max(0, until - interval.since));
	};
	const replicaEvents = events
		.filter((item) => !APP_LEVEL_ONLY_TYPES.has(item.type) && item.at.getTime() < accountingEnd)
		.sort((a, b) => a.at.getTime() - b.at.getTime());
	for (const event of replicaEvents) {
		const key = `${event.appId}:${event.replicaId}`;
		const at = Math.max(start.getTime(), event.at.getTime());
		if (event.type === 'STARTED') {
			integrate(key, at);
			running.set(key, { appId: event.appId, resources: event.resources, since: at });
		} else if (event.type === 'REDEPLOYED') {
			if (running.has(key)) {
				integrate(key, at);
				running.set(key, { appId: event.appId, resources: event.resources, since: at });
			}
		} else {
			integrate(key, at);
			running.delete(key);
		}
	}
	for (const key of running.keys()) integrate(key, accountingEnd);

	// --- Billing inputs: resources/replicaCount/installedDayFraction/storageGbDay.
	// Derived exclusively from per-APP INSTALLED/REPLICAS_CHANGED/UNINSTALLED (and
	// a revoke QUARANTINED) events — never from the current app document — so a
	// past day re-rolls to the same numbers from the retained event log alone.
	//
	// Billable intervals per appId are time-ordered [INSTALLED, next closer).
	// A REPLICAS_CHANGED re-bases the open interval without closing it. Within
	// one day an app can hold several different resource/replicaCount values
	// across segments (e.g. HA for part of the day, single for the rest); since
	// the portal prices the day from these fields, the correct exposure is the
	// segment that would price highest — simplified here to the max memoryMb,
	// max cpus, and max replicaCount independently observed across the day's
	// installed segments (never a segment average, which could under-bill).
	const appLevelEventsByApp = new Map<string, AppLifecycleEvent[]>();
	for (const event of events) {
		if (!BILLING_INTERVAL_TYPES.has(event.type)) continue;
		const list = appLevelEventsByApp.get(event.appId);
		if (list) list.push(event);
		else appLevelEventsByApp.set(event.appId, [event]);
	}

	for (const [appId, appEvents] of appLevelEventsByApp) {
		const sorted = [...appEvents].sort((a, b) => a.at.getTime() - b.at.getTime());
		const closedSegments: Array<OpenInterval & { end: number }> = [];
		let open: OpenInterval | null = null;
		for (const event of sorted) {
			const at = event.at.getTime();
			if (event.type === 'INSTALLED') {
				// A retried/replayed INSTALLED is idempotent: keep the earlier open
				// interval instead of forking a second one at the same instant.
				if (!open) open = { since: at, resources: event.resources, replicaCount: event.replicaCount ?? 1, storageBytes: event.storageBytes };
			} else if (event.type === 'REPLICAS_CHANGED' || event.type === 'RESIZED') {
				// RESIZED re-bases resources only (replicaCount falls back to the
				// open segment's — a resize never changes replica count).
				if (!open) continue;
				closedSegments.push({ ...open, end: at });
				open = { since: at, resources: event.resources ?? open.resources, replicaCount: event.replicaCount ?? open.replicaCount, storageBytes: open.storageBytes };
			} else {
				// UNINSTALLED or a revoke-teardown QUARANTINED: both close the interval.
				if (!open) continue;
				closedSegments.push({ ...open, end: at });
				open = null;
			}
		}
		if (open) closedSegments.push({ ...open, end: accountingEnd });

		let installedMs = 0;
		let maxMemoryMb = 0;
		let maxCpus = 0;
		let maxTmpSizeMb: number | undefined;
		let maxReplicaCount = 0;
		let storageGbDay = 0;
		for (const segment of closedSegments) {
			const segStart = Math.max(start.getTime(), segment.since);
			const segEnd = Math.min(accountingEnd, segment.end);
			if (segEnd <= segStart) continue;
			const ms = segEnd - segStart;
			installedMs += ms;
			maxMemoryMb = Math.max(maxMemoryMb, segment.resources.memoryMb);
			maxCpus = Math.max(maxCpus, segment.resources.cpus);
			if (segment.resources.tmpSizeMb !== undefined) maxTmpSizeMb = Math.max(maxTmpSizeMb ?? 0, segment.resources.tmpSizeMb);
			maxReplicaCount = Math.max(maxReplicaCount, segment.replicaCount);
			if (segment.storageBytes) storageGbDay += (segment.storageBytes / GIB) * (ms / DAY_MS);
		}
		if (installedMs <= 0) continue; // no billable segment overlaps this UTC day
		const row = appUsage(appId);
		row.installedDayFraction = installedMs / DAY_MS;
		row.resources = { memoryMb: maxMemoryMb, cpus: maxCpus, ...(maxTmpSizeMb !== undefined ? { tmpSizeMb: maxTmpSizeMb } : {}) };
		row.replicaCount = maxReplicaCount;
		row.storageGbDay = storageGbDay;
	}

	// --- Legacy fallback: an app installed before app-level billing events
	// existed carries no INSTALLED/UNINSTALLED at all. Bill it from
	// [createdAt, first REMOVED after createdAt) — the same window today's
	// (pre-this-change) code used — so it keeps billing instead of silently
	// going to zero. Filtering REMOVED to strictly after createdAt is what
	// fixes the reinstall-bills-$0 bug: a tombstone revive keeps the same
	// appId with a fresh createdAt, so a REMOVED event from the appId's
	// previous life (necessarily at or before that old createdAt) can never
	// be mistaken for this incarnation's removal.
	for (const app of apps) {
		if (appLevelEventsByApp.has(app.appId)) continue;
		const everStarted = events.some((event) => event.appId === app.appId && event.type === 'STARTED');
		if (!everStarted) continue; // never activated: never billed
		const removalTimes = events
			.filter((event) => event.appId === app.appId && event.type === 'REMOVED' && event.at.getTime() > app.createdAt.getTime())
			.map((event) => event.at.getTime());
		const removedAt = removalTimes.length ? Math.min(...removalTimes) : undefined;
		const storageStart = Math.max(start.getTime(), app.createdAt.getTime());
		const storageEnd = Math.min(accountingEnd, removedAt ?? accountingEnd);
		if (storageEnd <= storageStart) continue;
		const row = appUsage(app.appId);
		row.installedDayFraction = (storageEnd - storageStart) / DAY_MS;
		row.resources = {
			memoryMb: app.resources.memoryMb,
			cpus: app.resources.cpus,
			...(app.resources.tmpSizeMb !== undefined ? { tmpSizeMb: app.resources.tmpSizeMb } : {}),
		};
		row.replicaCount = Math.max(app.replicas.length, 1);
		if (app.storageBytes > 0) {
			row.storageGbDay = (app.storageBytes / GIB) * ((storageEnd - storageStart) / DAY_MS);
		}
	}

	const breakdown = [...perApp.values()].sort((a, b) => a.appId.localeCompare(b.appId));
	return {
		workspaceId,
		date: start,
		ramGbHours: breakdown.reduce((sum, row) => sum + row.ramGbHours, 0),
		cpuHours: breakdown.reduce((sum, row) => sum + row.cpuHours, 0),
		storageGbDay: breakdown.reduce((sum, row) => sum + row.storageGbDay, 0),
		perApp: breakdown,
		computedAt: new Date(),
	};
}

export class UsageAggregator {
	constructor(private readonly repositories: MasterRepositories) {}

	async rollup(date: Date, asOf = new Date()): Promise<{ workspaces: number }> {
		const start = utcDay(date);
		const end = new Date(start.getTime() + DAY_MS);
		const [events, apps] = await Promise.all([
			this.repositories.lifecycleEvents.find({ at: { $lt: end } }).toArray(),
			this.repositories.apps.find({ createdAt: { $lt: end } }).toArray(),
		]);
		const workspaceIds = new Set([...events.map((event) => event.workspaceId), ...apps.map((app) => app.workspaceId)]);
		for (const workspaceId of workspaceIds) {
			const row = aggregateWorkspaceDay(
				workspaceId,
				start,
				events.filter((event) => event.workspaceId === workspaceId),
				apps.filter((app) => app.workspaceId === workspaceId),
				asOf,
			);
			await this.repositories.usageDaily.updateOne(
				{ workspaceId, date: start },
				{ $set: row },
				{ upsert: true },
			);
		}
		return { workspaces: workspaceIds.size };
	}
}
