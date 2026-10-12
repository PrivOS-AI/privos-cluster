import { z } from 'zod';
import { RUNTIME_SECURITY_PROFILES, type RuntimeSecurityProfile } from '../types/index.js';

/**
 * Parse `<profile>:<listingId>[,<profile>:<listingId>...]` into listingId -> profile.
 * Empty or missing means no listing gets a profile. A malformed entry, an unknown
 * profile name or a listing mapped to two profiles throws: a typo must never
 * silently widen or drop a grant.
 */
export function parseSecurityProfileAllowlist(raw: string | undefined): Map<string, RuntimeSecurityProfile> {
	const result = new Map<string, RuntimeSecurityProfile>();
	if (!raw?.trim()) return result;
	for (const entry of raw.split(',')) {
		const text = entry.trim();
		const separator = text.indexOf(':');
		const profile = text.slice(0, separator);
		const listingId = text.slice(separator + 1).trim();
		if (separator < 1 || !listingId || !/^[A-Za-z0-9_.-]{1,128}$/.test(listingId)) {
			throw new Error(`malformed security profile allowlist entry: ${JSON.stringify(text)}`);
		}
		if (!(RUNTIME_SECURITY_PROFILES as readonly string[]).includes(profile)) {
			throw new Error(`unknown security profile in allowlist: ${JSON.stringify(profile)}`);
		}
		if (result.has(listingId)) throw new Error(`listing ${listingId} appears twice in the security profile allowlist`);
		result.set(listingId, profile as RuntimeSecurityProfile);
	}
	return result;
}

const MasterConfigSchema = z.object({
	MASTER_PORT: z.coerce.number().int().positive().default(4200),
	MASTER_HOST: z.string().default('127.0.0.1'),
	MASTER_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
	MASTER_MONGODB_URL: z.string().min(1),
	MASTER_MONGODB_DB: z.string().default('privos_registration'),
	APP_MASTER_SERVICE_KEY: z.string().min(32),
	APP_MASTER_KEY_ENCRYPTION_KEY_B64: z.string().min(1),
	APPS_BASE_DOMAIN: z.string().default('privos.link'),
	APPS_INGRESS_ENABLED: z
		.string()
		.default('false')
		.transform((value) => value === 'true' || value === '1'),
	CF_APPS_ZONE_ID: z.string().optional(),
	CF_APPS_API_TOKEN: z.string().optional(),
	APP_MASTER_CLUSTER_ID: z.string().regex(/^[A-Za-z0-9-]+$/).default('privos-app-cluster'),
	APP_CLUSTER_MCP_INSTALL_V2: z.enum(['on', 'off']).default('off'),
	APP_CLUSTER_MCP_INSTALL_V3: z.enum(['on', 'off']).default('off'),
	// Configuration-redeploy kill switch. Defaults on wherever v3 installs are
	// on: the route is additive and disabling it leaves installs untouched.
	APP_CLUSTER_MCP_RECONFIGURE_V3: z.enum(['on', 'off']).default('on'),
	// In-place image upgrade kill switch. Same reasoning as reconfigure: additive
	// route, installs/uninstalls/reconfigures are untouched when this is off.
	APP_CLUSTER_MCP_UPGRADE_V3: z.enum(['on', 'off']).default('on'),
	MCP_RELEASE_AUTHORITY_JWKS_JSON: z.string().default('{"keys":[]}'),
	// Public-hostnames feature (plan 260924-2220). All default to inert so a
	// fleet that has not rolled the edge behaves byte-identically:
	//   - NO_DEFAULT_HOST off  => v3 creates still allocate the legacy label.
	//   - EMIT_APP_PUBLIC_URL off (default) => the container never sees the
	//     renamed PRIVOS_APP_PUBLIC_URL key at all — byte-identical to today.
	//     Control nodes (master) and gen nodes (agent) deploy separately and
	//     non-atomically, so a rolled-ahead master must not emit a key an
	//     older agent's PlatformEnvNameSchema enum does not yet accept — that
	//     would 400 every v3 deploy/reconfigure/upgrade for the whole rollout
	//     window. The operator flips this on in phase 7, after every agent has
	//     rolled.
	//   - LEGACY_PUBLIC_URL_ALIAS on (default) => while EMIT_APP_PUBLIC_URL is
	//     also on, runtimes receive BOTH keys with the same value during the
	//     rename transition; off => only the renamed key.
	// Net emission matrix: default (emit off) => {PRIVOS_PUBLIC_URL} only;
	// emit-on + alias-on => {both}; emit-on + alias-off => {PRIVOS_APP_PUBLIC_URL} only.
	MCP_V3_NO_DEFAULT_HOST: z.enum(['on', 'off']).default('off'),
	MCP_EMIT_APP_PUBLIC_URL: z.enum(['on', 'off']).default('off'),
	MCP_LEGACY_PUBLIC_URL_ALIAS: z.enum(['on', 'off']).default('on'),
	// Runtime security profiles (e.g. browser-sandbox). The allowlist maps an
	// attested listingId to a profile; empty/missing grants nothing. Malformed
	// entries or unknown profile names fail config load. EMIT follows the
	// EMIT_APP_PUBLIC_URL skew pattern: off (default) never sends the
	// `securityProfile` key, so an agent that predates it keeps working; flip on
	// only after every agent has rolled.
	MCP_V3_SECURITY_PROFILE_ALLOWLIST: z.string().default(''),
	MCP_V3_EMIT_SECURITY_PROFILE: z.enum(['on', 'off']).default('off'),
	// Days a WS_SUSPENDED host keeps its Cloudflare custom hostname before the
	// daily release job deletes it (resume recreates it). DEV E2E sets 0.
	APP_HOST_SUSPEND_CF_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),
	// Token scoped to custom-hostname operations on the privos.link SaaS zone.
	// Separate from CF_APPS_API_TOKEN (wildcard/CNAME DNS) by least privilege.
	CF_APPS_SAAS_API_TOKEN: z.string().optional(),
}).superRefine((config, ctx) => {
	try {
		parseSecurityProfileAllowlist(config.MCP_V3_SECURITY_PROFILE_ALLOWLIST);
	} catch (error) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['MCP_V3_SECURITY_PROFILE_ALLOWLIST'],
			message: error instanceof Error ? error.message : 'invalid allowlist',
		});
	}
	let key: Buffer | null = null;
	try {
		key = Buffer.from(config.APP_MASTER_KEY_ENCRYPTION_KEY_B64, 'base64');
	} catch {
		// handled below
	}
	if (key?.length !== 32) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['APP_MASTER_KEY_ENCRYPTION_KEY_B64'],
			message: 'must decode to exactly 32 bytes',
		});
	}
	if (config.APPS_INGRESS_ENABLED && (!config.CF_APPS_ZONE_ID || !config.CF_APPS_API_TOKEN)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['CF_APPS_API_TOKEN'],
			message: 'ingress requires CF_APPS_ZONE_ID and CF_APPS_API_TOKEN',
		});
	}
	if (config.APP_CLUSTER_MCP_INSTALL_V2 === 'on' || config.APP_CLUSTER_MCP_INSTALL_V3 === 'on') {
		try {
			const trust = JSON.parse(config.MCP_RELEASE_AUTHORITY_JWKS_JSON) as { keys?: Array<Record<string, unknown>> };
			if (!Array.isArray(trust.keys) || trust.keys.length < 1 || trust.keys.some((key) => key.d)) throw new Error('invalid trust set');
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['MCP_RELEASE_AUTHORITY_JWKS_JSON'],
				message: 'MCP installation requires a non-empty public-only release authority JWKS',
			});
		}
	}
});

export type MasterConfig = z.infer<typeof MasterConfigSchema>;

export function loadMasterConfig(env: NodeJS.ProcessEnv = process.env): MasterConfig {
	return MasterConfigSchema.parse(env);
}
