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
	const perApp = new Map<string, { appId: string; ramGbHours: number; cpuHours: number; storageGbDay: number }>();
	const running = new Map<string, { appId: string; resources: AppLifecycleEvent['resources']; since: number }>();
	const appUsage = (appId: string) => {
		const existing = perApp.get(appId);
		if (existing) return existing;
		const created = { appId, ramGbHours: 0, cpuHours: 0, storageGbDay: 0 };
		perApp.set(appId, created);
		return created;
	};
	const integrate = (key: string, until: number) => {
		const interval = running.get(key);
		if (!interval) return;
		addCompute(appUsage(interval.appId), interval.resources, Math.max(0, until - interval.since));
	};

	for (const event of [...events].filter((item) => item.at.getTime() < accountingEnd).sort((a, b) => a.at.getTime() - b.at.getTime())) {
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

	const removedAt = new Map<string, number>();
	for (const event of events) {
		if (event.type === 'REMOVED') {
			const current = removedAt.get(event.appId);
			if (current === undefined || event.at.getTime() > current) removedAt.set(event.appId, event.at.getTime());
		}
	}
	for (const app of apps) {
		const storageStart = Math.max(start.getTime(), app.createdAt.getTime());
		const storageEnd = Math.min(accountingEnd, removedAt.get(app.appId) ?? accountingEnd);
		if (storageEnd > storageStart && app.storageBytes > 0) {
			appUsage(app.appId).storageGbDay += (app.storageBytes / GIB) * ((storageEnd - storageStart) / DAY_MS);
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
