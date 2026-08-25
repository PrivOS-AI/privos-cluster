import type { AppLifecycleService } from './app-lifecycle-service.js';
import type { MasterRepositories } from './repositories.js';

export const DEFAULT_QUARANTINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Resolve the quarantine grace window from the environment, falling back to 7d.
 * A malformed or non-positive value is ignored (uses the default) so a bad env
 * can never make the reaper destroy quarantined workloads immediately.
 */
export function resolveQuarantineGraceMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env.APP_CLUSTER_QUARANTINE_GRACE_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_QUARANTINE_GRACE_MS;
}

export interface QuarantineReaperResult {
	scanned: number;
	reaped: number;
	failed: number;
}

/**
 * Permanently remove every app that has been QUARANTINED longer than the grace
 * window. Each app is reaped independently: one failure is logged and the rest
 * still run, and a failure leaves the app QUARANTINED so the next tick retries —
 * never a half-state that looks live. Idempotent and safe to run repeatedly.
 */
export async function reapExpiredQuarantines(
	repositories: MasterRepositories,
	lifecycle: AppLifecycleService,
	options: { graceMs?: number; now?: Date; log?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void } } = {},
): Promise<QuarantineReaperResult> {
	const graceMs = options.graceMs ?? resolveQuarantineGraceMs();
	const now = options.now ?? new Date();
	const cutoff = new Date(now.getTime() - graceMs);

	const expired = await repositories.apps
		.find({ state: 'QUARANTINED', quarantinedAt: { $lte: cutoff } })
		.toArray();

	let reaped = 0;
	let failed = 0;
	for (const app of expired) {
		try {
			await lifecycle.reapQuarantined(app.workspaceId, app.appId);
			reaped += 1;
			options.log?.info({ workspaceId: app.workspaceId, appId: app.appId, quarantinedAt: app.quarantinedAt }, 'quarantined app reaped');
		} catch (error) {
			failed += 1;
			options.log?.error({ err: error, workspaceId: app.workspaceId, appId: app.appId }, 'quarantined app reap failed — will retry next tick');
		}
	}
	return { scanned: expired.length, reaped, failed };
}
