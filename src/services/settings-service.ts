/**
 * Typed accessors for cluster settings. Values come from the DB if present,
 * otherwise fall back to the defaults declared here.
 *
 * Add a new setting in three steps:
 *   1. Append a key constant below
 *   2. Add an entry to DEFAULTS
 *   3. Add a typed getter (optional but recommended for callers)
 */
import * as settingsRepo from '../db/settings-repo.js';

// ---------------------------------------------------------------------------
// Setting keys & defaults
// ---------------------------------------------------------------------------

export const SETTING_KEYS = {
	REVERSE_PROXY_BASE_DOMAIN: 'reverse_proxy.base_domain',
	REVERSE_PROXY_DOMAINS: 'reverse_proxy.domains',
	REVERSE_PROXY_ENABLED: 'reverse_proxy.enabled',
	DEFAULT_RESOURCES: 'deploy.default_resources',
	MAX_MEMORY_MB_TOTAL: 'quota.max_memory_mb_total',
	MAX_CPUS_TOTAL: 'quota.max_cpus_total',
	IMAGE_REGISTRY_ALLOWLIST: 'images.registry_allowlist',
} as const;

export interface DefaultResources {
	memoryMb: number;
	cpus: number;
	tmpSizeMb: number;
}

export interface SettingsShape {
	[SETTING_KEYS.REVERSE_PROXY_BASE_DOMAIN]: string;       // legacy single domain (kept for compat)
	[SETTING_KEYS.REVERSE_PROXY_DOMAINS]: string[];         // list of base domains for multi-domain hosting
	[SETTING_KEYS.REVERSE_PROXY_ENABLED]: boolean;
	[SETTING_KEYS.DEFAULT_RESOURCES]: DefaultResources;
	[SETTING_KEYS.MAX_MEMORY_MB_TOTAL]: number | null;      // null = read from Docker host
	[SETTING_KEYS.MAX_CPUS_TOTAL]: number | null;           // null = read from Docker host
	[SETTING_KEYS.IMAGE_REGISTRY_ALLOWLIST]: string[];      // empty = allow any
}

export const DEFAULTS: SettingsShape = {
	[SETTING_KEYS.REVERSE_PROXY_BASE_DOMAIN]: '',
	[SETTING_KEYS.REVERSE_PROXY_DOMAINS]: [],
	[SETTING_KEYS.REVERSE_PROXY_ENABLED]: false,
	[SETTING_KEYS.DEFAULT_RESOURCES]: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 },
	[SETTING_KEYS.MAX_MEMORY_MB_TOTAL]: null,
	[SETTING_KEYS.MAX_CPUS_TOTAL]: null,
	[SETTING_KEYS.IMAGE_REGISTRY_ALLOWLIST]: [],
};

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export function getValue<K extends keyof SettingsShape>(key: K): SettingsShape[K] {
	const row = settingsRepo.get<SettingsShape[K]>(key);
	return row ? row.value : DEFAULTS[key];
}

export function getAllResolved(): Record<string, unknown> {
	const stored = Object.fromEntries(settingsRepo.findAll().map((s) => [s.key, s.value]));
	const merged: Record<string, unknown> = { ...DEFAULTS };
	for (const [k, v] of Object.entries(stored)) merged[k] = v;
	return merged;
}

// ---------------------------------------------------------------------------
// Typed conveniences used elsewhere
// ---------------------------------------------------------------------------

/**
 * The list of base domains available for publishing apps. Seeded from the
 * legacy single base_domain if the list is empty, so upgrades keep working.
 */
export function getDomains(): string[] {
	const list = getValue(SETTING_KEYS.REVERSE_PROXY_DOMAINS)
		.map((d) => d.trim())
		.filter(Boolean);
	if (list.length > 0) return list;
	const legacy = getValue(SETTING_KEYS.REVERSE_PROXY_BASE_DOMAIN).trim();
	return legacy ? [legacy] : [];
}

/** Backward-compat: first domain in the list (was a single value before). */
export function getBaseDomain(): string {
	return getDomains()[0] ?? '';
}

/** Validate a requested domain against the configured list; null if not allowed. */
export function resolveDomain(requested?: string | null): string | null {
	const domains = getDomains();
	if (domains.length === 0) return null;
	if (!requested) return domains[0]; // default to first
	const match = domains.find((d) => d === requested.trim());
	return match ?? null;
}

export function isReverseProxyEnabled(): boolean {
	return Boolean(getValue(SETTING_KEYS.REVERSE_PROXY_ENABLED)) && getDomains().length > 0;
}

export function getDefaultResources(): DefaultResources {
	return getValue(SETTING_KEYS.DEFAULT_RESOURCES);
}

export function getMaxMemoryMb(): number | null {
	return getValue(SETTING_KEYS.MAX_MEMORY_MB_TOTAL);
}

export function getMaxCpus(): number | null {
	return getValue(SETTING_KEYS.MAX_CPUS_TOTAL);
}

export function getImageRegistryAllowlist(): string[] {
	return getValue(SETTING_KEYS.IMAGE_REGISTRY_ALLOWLIST);
}

export function isKnownKey(key: string): key is keyof SettingsShape {
	return Object.values(SETTING_KEYS).includes(key as (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS]);
}
