/**
 * Cluster settings — env/config only, no settings database.
 *
 * Resource caps, app network, operator routes and image registry policy are
 * env-configurable. Fleet mode validates fail-closed policy at process start.
 */
import { config } from '../config.js';

export interface DefaultResources {
	memoryMb: number;
	cpus: number;
	tmpSizeMb: number;
}

/** Base domains available for publishing apps, from the PRIVOS_DOMAINS env var (CSV). */
export function getDomains(): string[] {
	return config.PRIVOS_DOMAINS
		.split(',')
		.map((d) => d.trim())
		.filter(Boolean);
}

/** Validate a requested domain against the configured list; defaults to the first if unset. */
export function resolveDomain(requested?: string | null): string | null {
	const domains = getDomains();
	if (domains.length === 0) return null;
	if (!requested) return domains[0];
	const match = domains.find((d) => d === requested.trim());
	return match ?? null;
}

/** Which reverse proxy fronts apps: off | caddy | native. */
export function getReverseProxyMode(): 'off' | 'caddy' | 'native' {
	return config.REVERSE_PROXY_MODE;
}

/** The internal HTTP port the native proxy binds (non-secret; surfaced to hub guidance). */
export function getProxyPort(): number {
	return config.PROXY_PORT;
}

/**
 * Whether apps should be published under a base domain (resolve baseDomain +
 * emit routing labels at deploy time). `native` is driven purely by mode +
 * domains (the config refinement guarantees domains); `caddy` keeps the legacy
 * REVERSE_PROXY_ENABLED gate; `off` disables routing entirely.
 */
export function isReverseProxyEnabled(): boolean {
	const mode = getReverseProxyMode();
	if (mode === 'off') return false;
	if (mode === 'native') return getDomains().length > 0;
	return config.REVERSE_PROXY_ENABLED && getDomains().length > 0;
}

export function getDefaultResources(): DefaultResources {
	return {
		memoryMb: config.DEFAULT_MEMORY_MB,
		cpus: config.DEFAULT_CPUS,
		tmpSizeMb: config.DEFAULT_TMP_MB,
	};
}

export function getMaxMemoryMb(): number | null {
	return config.CLUSTER_MAX_MEMORY_MB ?? null;
}

export function getMaxCpus(): number | null {
	return config.CLUSTER_MAX_CPUS ?? null;
}

export function getImageRegistryAllowlist(): string[] {
	return config.IMAGE_REGISTRY_ALLOWLIST
		.split(',')
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
}

export function getAppNetworkName(): string {
	return config.APP_NETWORK_NAME?.trim() || config.DOCKER_NETWORK;
}

export function areOperatorRoutesEnabled(): boolean {
	return config.CLUSTER_OPERATOR_ROUTES === 'on';
}
