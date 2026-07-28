/**
 * Privos Cluster — Fastify entry point.
 * Stateless Docker agent: bootstraps Docker + background services and
 * registers HTTP/WebSocket routes. No local database — Docker (container
 * labels, images) is the only source of truth.
 */
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';

import { config } from './config.js';
import { networkManager } from './docker/index.js';
import { startHealthMonitor, stopHealthMonitor } from './services/health-monitor.js';
import { startReverseProxy, stopReverseProxy } from './proxy/reverse-proxy-server.js';
import authPlugin from './plugins/auth.js';
import capabilitiesHandler from './handlers/capabilities.js';
import appsHandler from './handlers/apps.js';
import imagesHandler from './handlers/images.js';
import logsHandler from './handlers/logs.js';
import filesHandler from './handlers/files.js';
import terminalHandler from './handlers/terminal.js';
import clusterHandler from './handlers/cluster.js';
import authRoutesHandler from './handlers/auth.js';
import usageHandler from './handlers/usage.js';
import { areOperatorRoutesEnabled } from './services/settings-service.js';

const fastify = Fastify({
	logger: {
		level: config.LOG_LEVEL,
		transport:
			config.NODE_ENV === 'development'
				? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
				: undefined,
	},
	disableRequestLogging: false,
	trustProxy: true,
});

// Public health endpoint — no authentication required
fastify.get('/api/v1/health', async () => ({
	status: 'ok',
	service: 'privos-cluster',
	version: '0.1.0',
	uptime: Math.floor(process.uptime()),
	ts: Date.now(),
}));

async function main(): Promise<void> {
	try {
		// 1. Ensure Docker network. The cluster is stateless — Docker itself
		//    (containers, labels, images) is the only source of truth; there is
		//    no local database to initialize or reconcile.
		await networkManager.ensureNetwork();
		if (!config.FLEET_MODE) {
			fastify.log.info({ network: config.DOCKER_NETWORK }, 'docker network ready');
		}

		// 2. Register CORS (frontend dev server origin). Skipped if explicitly disabled.
		if (config.CORS_ORIGIN) {
			const origins =
				config.CORS_ORIGIN === '*'
					? true
					: config.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
			await fastify.register(cors, {
				origin: origins,
				credentials: true,
				methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
				allowedHeaders: ['Content-Type', 'Authorization'],
			});
			fastify.log.info({ origins }, 'cors enabled');
		}

		// 3. Register WebSocket plugin (must be before websocket route handlers)
		await fastify.register(websocket, { options: { maxPayload: 1024 * 1024 } });

		// 4. Register public handlers (no auth)
		await fastify.register(capabilitiesHandler);

		// 5. Register auth plugin (decorates fastify.authenticate)
		await fastify.register(authPlugin);

		// 6. Auth introspection route (/me; protected via preHandler inside)
		await fastify.register(authRoutesHandler);

		// 7. Register protected route handlers
		await fastify.register(appsHandler);
		await fastify.register(imagesHandler);
		await fastify.register(clusterHandler);
		await fastify.register(logsHandler);
		await fastify.register(usageHandler);
		if (areOperatorRoutesEnabled()) {
			await fastify.register(filesHandler);
			await fastify.register(terminalHandler);
		}

		// 8. Start background services
		startHealthMonitor();

		// 9. Listen
		await fastify.listen({ port: config.PORT, host: config.HOST });
		fastify.log.info({ port: config.PORT, host: config.HOST }, 'privos-cluster ready');

		// 10. Native reverse proxy (only in `native` mode). cloudflared terminates
		//     TLS at the edge and forwards `*.<domain> → localhost:<PROXY_PORT>`.
		if (config.REVERSE_PROXY_MODE === 'native') {
			await startReverseProxy();
			fastify.log.info({ proxyPort: config.PROXY_PORT }, 'native reverse proxy started');
		}
	} catch (err) {
		fastify.log.error(err, 'failed to start');
		process.exit(1);
	}
}

async function shutdown(signal: string): Promise<void> {
	fastify.log.info({ signal }, 'shutdown initiated');
	try {
		stopHealthMonitor();
		await stopReverseProxy();
		await fastify.close();
		fastify.log.info('shutdown complete');
		process.exit(0);
	} catch (err) {
		fastify.log.error(err, 'shutdown error');
		process.exit(1);
	}
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
	fastify.log.fatal(err, 'uncaughtException');
	process.exit(1);
});
process.on('unhandledRejection', (reason) => {
	fastify.log.fatal({ reason }, 'unhandledRejection');
	process.exit(1);
});

void main();
