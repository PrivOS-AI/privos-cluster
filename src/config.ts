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

	JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),

	HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

	// Reverse proxy / hosting — replaces the old settings DB (env is now the
	// only source of truth for cluster-wide config).
	PRIVOS_DOMAINS: z.string().default(''), // comma-separated base domains
	REVERSE_PROXY_ENABLED: z
		.string()
		.default('false')
		.transform((v) => v === 'true' || v === '1'),

	// Default per-container resource allocation when a deploy request omits them.
	DEFAULT_MEMORY_MB: z.coerce.number().int().positive().default(256),
	DEFAULT_CPUS: z.coerce.number().positive().default(0.5),
	DEFAULT_TMP_MB: z.coerce.number().int().positive().default(64),

	// CORS — comma-separated origins, or "*" for any. Empty disables CORS entirely.
	CORS_ORIGIN: z.string().default('http://localhost:5173'),
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
