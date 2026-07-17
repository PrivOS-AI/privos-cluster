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

	SQLITE_PATH: z.string().default('./data/cluster.db'),

	JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),

	PRIVOS_CHAT_WEBHOOK_URL: z.string().url(),

	HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

	// Admin UI auth — used by the web frontend (POST /api/v1/auth/login).
	// Leave ADMIN_PASSWORD empty in env to disable the admin login flow entirely.
	ADMIN_USERNAME: z.string().min(1).default('admin'),
	ADMIN_PASSWORD: z.string().default(''),

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
