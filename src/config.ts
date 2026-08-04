/**
 * Centralized environment config. Validates with zod on boot — fails fast on missing/invalid vars.
 */
import { z } from 'zod';

const ConfigSchema = z.object({
	PORT: z.coerce.number().int().positive().default(4000),
	HOST: z.string().default('0.0.0.0'),
	LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
	NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

	DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
	DOCKER_NETWORK: z.string().default('mcp-apps-network'),
	FLEET_MODE: z
		.string()
		.default('false')
		.transform((v) => v === 'true' || v === '1'),
	APP_NETWORK_NAME: z.string().optional(),
	IMAGE_REGISTRY_ALLOWLIST: z.string().default(''),
	CLUSTER_MAX_MEMORY_MB: z.coerce.number().int().positive().optional(),
	CLUSTER_MAX_CPUS: z.coerce.number().positive().optional(),
	CLUSTER_OPERATOR_ROUTES: z.enum(['on', 'off']).default('off'),

	JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars').optional(),
	FLEET_NODE_ID: z.string().regex(/^[A-Za-z0-9-]+$/).optional(),
	FLEET_NODE_KEY: z.string().min(32, 'FLEET_NODE_KEY must be at least 32 chars').optional(),
	FLEET_AGENT_CONTAINER: z.string().default('privos-cluster'),
	FLEET_CLUSTER_ID: z.string().regex(/^[A-Za-z0-9-]+$/).default('privos-app-cluster'),
	MCP_NODE_IDENTITY_KEY_PATH: z.string().startsWith('/').default('/var/lib/privos/node-identity.json'),
	MCP_BROKER_ROOT: z.string().startsWith('/').default('/run/privos/mcp-broker'),
	APP_CLUSTER_MCP_INSTALL_V3: z.enum(['on', 'off']).default('off'),

	HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

	// Reverse proxy / hosting — replaces the old settings DB (env is now the
	// only source of truth for cluster-wide config).
	PRIVOS_DOMAINS: z.string().default(''), // comma-separated base domains
	REVERSE_PROXY_ENABLED: z
		.string()
		.default('false')
		.transform((v) => v === 'true' || v === '1'),

	// Which reverse proxy fronts apps:
	//   off    — no routing (apps get no public host).
	//   caddy  — emit caddy-docker-proxy labels; an external Caddy routes (legacy).
	//   native — the cluster's own HTTP proxy routes by Host; TLS is terminated by
	//            the cloudflared tunnel at the Cloudflare edge (no certs here).
	REVERSE_PROXY_MODE: z.enum(['off', 'caddy', 'native']).default('caddy'),
	// Internal HTTP port the native proxy binds (loopback); cloudflared forwards
	// `*.<domain> → http://localhost:<PROXY_PORT>`. No public 80/443 on the host.
	PROXY_PORT: z.coerce.number().int().positive().default(8080),

	// Default per-container resource allocation when a deploy request omits them.
	DEFAULT_MEMORY_MB: z.coerce.number().int().positive().default(256),
	DEFAULT_CPUS: z.coerce.number().positive().default(0.5),
	DEFAULT_TMP_MB: z.coerce.number().int().positive().default(64),

	// CORS — comma-separated origins, or "*" for any. Empty disables CORS entirely.
	CORS_ORIGIN: z.string().default('http://localhost:5173'),
}).superRefine((cfg, ctx) => {
	if (!cfg.FLEET_MODE && !cfg.JWT_SECRET) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['JWT_SECRET'],
			message: 'JWT_SECRET is required outside fleet mode',
		});
	}

	if (cfg.FLEET_MODE && (!cfg.FLEET_NODE_ID || !cfg.FLEET_NODE_KEY)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['FLEET_NODE_KEY'],
			message: 'FLEET_MODE=true requires FLEET_NODE_ID and FLEET_NODE_KEY',
		});
	}

	if (cfg.FLEET_MODE && !/^10\.88\.\d{1,3}\.\d{1,3}$/.test(cfg.HOST)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['HOST'],
			message: 'FLEET_MODE=true requires HOST to be a WireGuard 10.88.0.0/16 address',
		});
	}

	if (cfg.FLEET_MODE && !cfg.IMAGE_REGISTRY_ALLOWLIST.split(',').some((host) => host.trim())) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['IMAGE_REGISTRY_ALLOWLIST'],
			message: 'FLEET_MODE=true requires a non-empty IMAGE_REGISTRY_ALLOWLIST',
		});
	}

	// Native routing is useless without at least one base domain to match Host against.
	if (cfg.REVERSE_PROXY_MODE === 'native') {
		const hasDomain = cfg.PRIVOS_DOMAINS.split(',').some((d) => d.trim());
		if (!hasDomain) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['PRIVOS_DOMAINS'],
				message: 'REVERSE_PROXY_MODE=native requires PRIVOS_DOMAINS to be set (comma-separated base domains)',
			});
		}
	}
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
	const parsed = ConfigSchema.safeParse(process.env);
	if (!parsed.success) {
		console.error('Invalid environment configuration:');
		for (const issue of parsed.error.issues) {
			console.error(`  ${issue.path.join('.')}: ${issue.message}`);
		}
		process.exit(1);
	}
	return parsed.data;
}

export const config = loadConfig();
