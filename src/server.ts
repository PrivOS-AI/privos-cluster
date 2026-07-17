/**
 * Privos Cluster — Fastify entry point.
 * Bootstraps DB, Docker, background services, and HTTP/WebSocket routes.
 */
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';

import { config } from './config.js';
import { getDb, closeDb } from './db/client.js';
import { networkManager, reconcileState, reconcileImages } from './docker/index.js';
import { healthMonitor } from './services/health-monitor.js';
import { startWorker as startWebhookWorker, stopWorker as stopWebhookWorker } from './services/webhook-sender.js';
import authPlugin from './plugins/auth.js';
import capabilitiesHandler from './handlers/capabilities.js';
import appsHandler from './handlers/apps.js';
import imagesHandler from './handlers/images.js';
import buildsHandler from './handlers/builds.js';
import logsHandler from './handlers/logs.js';
import filesHandler from './handlers/files.js';
import terminalHandler from './handlers/terminal.js';
import settingsHandler from './handlers/settings.js';
import clusterHandler from './handlers/cluster.js';
import authRoutesHandler from './handlers/auth.js';
import registriesHandler from './handlers/registries.js';

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
		// 1. Init DB (fail-fast if disk not writable)
		getDb();
		fastify.log.info('database initialized');

		// 2. Ensure Docker network
		await networkManager.ensureNetwork();
		fastify.log.info({ network: config.DOCKER_NETWORK }, 'docker network ready');

		// 3. Reconcile state (DB ↔ Docker) — containers first, then images
		await reconcileState();
		await reconcileImages();
		fastify.log.info('state reconciled');

		// 4. Register CORS (frontend dev server origin). Skipped if explicitly disabled.
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

		// 5. Register WebSocket plugin (must be before websocket route handlers)
		await fastify.register(websocket, { options: { maxPayload: 1024 * 1024 } });

		// 5b. Register multipart plugin (image tarball uploads up to 2 GB).
		await fastify.register(multipart, {
			limits: {
				fileSize: 2 * 1024 * 1024 * 1024, // 2 GB
				files: 1,
			},
		});

		// 6. Register public handlers (no auth)
		await fastify.register(capabilitiesHandler);

		// 7. Register auth plugin (decorates fastify.authenticate)
		await fastify.register(authPlugin);

		// 8. Public-ish auth routes (login is public; /me is protected via preHandler inside)
		await fastify.register(authRoutesHandler);

		// 9. Register protected route handlers
		await fastify.register(appsHandler);
		await fastify.register(imagesHandler);
		await fastify.register(buildsHandler);
		await fastify.register(settingsHandler);
		await fastify.register(clusterHandler);
		await fastify.register(logsHandler);
		await fastify.register(filesHandler);
		await fastify.register(terminalHandler);
		await fastify.register(registriesHandler);

		// 8. Start background services
		healthMonitor.start();
		startWebhookWorker();

		// 9. Listen
		await fastify.listen({ port: config.PORT, host: config.HOST });
		fastify.log.info({ port: config.PORT, host: config.HOST }, 'privos-cluster ready');
	} catch (err) {
		fastify.log.error(err, 'failed to start');
		process.exit(1);
	}
}

async function shutdown(signal: string): Promise<void> {
	fastify.log.info({ signal }, 'shutdown initiated');
	try {
		healthMonitor.stop();
		stopWebhookWorker();
		await fastify.close();
		closeDb();
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
