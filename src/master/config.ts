import { z } from 'zod';
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
}).superRefine((config, ctx) => {
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
