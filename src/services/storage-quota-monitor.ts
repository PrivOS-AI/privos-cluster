import pino from 'pino';
import { config } from '../config.js';
import { containerManager } from '../docker/index.js';

const logger = pino({ level: config.LOG_LEVEL }).child({ component: 'storage-quota' });

/** Quota for a volume whose app declared no `sizeMb`. */
export const DEFAULT_VOLUME_LIMIT_MB = 1024;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export function volumeLimitMb(labels: Record<string, string>): number {
	const declared = Number(labels['privos.size-mb']);
	return Number.isFinite(declared) && declared > 0 ? declared : DEFAULT_VOLUME_LIMIT_MB;
}

export function overQuotaVolumes(volumes: Array<{ name: string; bytes: number; labels: Record<string, string> }>) {
	return volumes
		.map((volume) => ({ ...volume, limitMb: volumeLimitMb(volume.labels) }))
		.filter((volume) => volume.bytes > volume.limitMb * 1024 * 1024);
}

/**
 * Soft quota: Docker's local driver cannot cap a volume on ext4, so an app can
 * still write past its size. The sweep names the app that did, for operators
 * and billing; it never stops the app (node disk itself is alerted by
 * privos-status).
 */
async function sweep(): Promise<void> {
	for (const volume of overQuotaVolumes(await containerManager.appVolumeUsage())) {
		logger.warn({
			event: 'storage_quota_exceeded',
			volume: volume.name,
			appId: volume.labels['privos.app-id'] || undefined,
			workspaceId: volume.labels['privos.workspace'] || undefined,
			usedMb: Math.round(volume.bytes / 1024 / 1024),
			limitMb: volume.limitMb,
		}, 'app volume is over its storage quota');
	}
}

let timer: NodeJS.Timeout | undefined;

export function startStorageQuotaMonitor(): void {
	const run = () => void sweep().catch((err) => logger.warn({ err: err.message }, 'storage quota sweep failed'));
	timer = setInterval(run, SWEEP_INTERVAL_MS);
	run();
}

export function stopStorageQuotaMonitor(): void {
	if (timer) clearInterval(timer);
}
