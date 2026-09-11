/**
 * Privos Cluster — Fastify entry point.
 * Stateless Docker agent: bootstraps Docker + background services and
 * registers HTTP/WebSocket routes. No local database — Docker (container
 * labels, images) is the only source of truth.
 *
 * Two deployment shapes share this one process:
 *  - HTTP/fleet path: opens a TCP listener (`fastify.listen`), same as always.
 *  - Tunnel path (`PRIVOS_HUB_URL` set): opens no listener at all. The
 *    tunnel client dials the Hub and replays its requests into this same
 *    Fastify instance via `fastify.inject()`.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';

import { config, isLocalRuntimeEnabled, isTunnelMode } from './config.js';
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
import mcpHandler from './handlers/mcp.js';
import localRuntimeHandler from './handlers/local-runtime.js';
import { areOperatorRoutesEnabled } from './services/settings-service.js';
import { mcpBrokerManager, rebindMcpBrokers } from './services/mcp-broker.js';
import { startTunnelClient, type TunnelClient } from './tunnel/tunnel-client.js';

/**
 * Builds and fully registers the Fastify instance (health route, CORS,
 * websocket, auth, every route handler) but never calls `.listen()` — the
 * caller decides whether to open a TCP listener (HTTP/fleet path) or drive
 * the instance purely through `fastify.inject()` (tunnel path).
 */
export async function buildFastifyServer(): Promise<FastifyInstance> {
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

	// Public health endpoint — no authentication required in every mode.
	fastify.get('/api/v1/health', async () => ({
		status: 'ok',
		service: 'privos-cluster',
		version: '0.1.0',
		uptime: Math.floor(process.uptime()),
		ts: Date.now(),
	}));

	// CORS (frontend dev server origin). Skipped if explicitly disabled.
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

	// WebSocket plugin (must be before websocket route handlers)
	await fastify.register(websocket, { options: { maxPayload: 1024 * 1024 } });

	// Auth plugin (decorates fastify.authenticate) registered before the
	// capabilities route so the tunnel-mode gate below can use it.
	await fastify.register(authPlugin);

	// In tunnel mode there is no TCP listener, so the otherwise-unauthenticated
	// `capabilities` route becomes a free probe over the tunnel unless it is
	// explicitly gated — every /api/v1 request must carry a valid Bearer.
	// capabilities.ts itself stays untouched (a public route on the HTTP/fleet
	// path); this hook only applies when there is no listener.
	if (isTunnelMode(config)) {
		fastify.addHook('onRequest', async (req, reply) => {
			if (req.url.split('?')[0] === '/api/v1/capabilities') {
				await fastify.authenticate(req, reply);
			}
		});
	}
	await fastify.register(capabilitiesHandler);

	// Auth introspection route (/me; protected via preHandler inside)
	await fastify.register(authRoutesHandler);

	// Protected route handlers
	await fastify.register(appsHandler);
	await fastify.register(imagesHandler);
	await fastify.register(clusterHandler);
	await fastify.register(logsHandler);
	await fastify.register(usageHandler);
	await fastify.register(mcpHandler);
	// `privos-local-runtime-driver-v1` ABI — on by default in tunnel mode
	// (customer-owned/BYO App Clusters), off by default otherwise (e.g. a
	// fleet/master HTTP deployment that never wants this surface).
	if (isLocalRuntimeEnabled(config)) {
		await fastify.register(localRuntimeHandler);
	}
	if (areOperatorRoutesEnabled()) {
		await fastify.register(filesHandler);
		await fastify.register(terminalHandler);
	}

	return fastify;
}

let fastify: FastifyInstance | undefined;
let tunnelClient: TunnelClient | undefined;
let networkSweepTimer: NodeJS.Timeout | undefined;

async function main(): Promise<void> {
	try {
		// 1. Ensure Docker network. The cluster is stateless — Docker itself
		//    (containers, labels, images) is the only source of truth; there is
		//    no local database to initialize or reconcile. This runs regardless
		//    of transport (HTTP listener or tunnel) — the cluster still manages
		//    Docker either way.
		await networkManager.ensureNetwork();
		const brokerRebind = await rebindMcpBrokers();

		fastify = await buildFastifyServer();
		fastify.log.info(brokerRebind, 'MCP identity brokers rebound');
		if (!config.FLEET_MODE) {
			fastify.log.info({ network: config.DOCKER_NETWORK }, 'docker network ready');
		}

		// Start background services
		startHealthMonitor();
		// Reclaim subnets of workspace app networks whose last container is
		// gone (uninstalled/purged workspaces). Docker's default address pools
		// hold ~31 bridge subnets per node; without this sweep the node
		// eventually cannot create any network and every install fails. The
		// 1h minimum age keeps the sweep clear of deploys in flight.
		if (config.FLEET_MODE) {
			const sweep = async (): Promise<void> => {
				const removed = await networkManager.sweepUnusedWorkspaceNetworks(60 * 60 * 1000);
				if (removed.length) fastify?.log.info({ removed }, 'unused workspace app networks removed');
			};
			networkSweepTimer = setInterval(() => void sweep().catch((err) => fastify?.log.warn(err, 'network sweep failed')), 60 * 60 * 1000);
			void sweep().catch((err) => fastify?.log.warn(err, 'network sweep failed'));
		}

		// Listen (HTTP/fleet path) or dial the Hub (tunnel path) — never both.
		if (isTunnelMode(config)) {
			tunnelClient = startTunnelClient(fastify);
			fastify.log.info({ hubUrl: config.PRIVOS_HUB_URL }, 'tunnel mode: dialing hub, no local listener');
		} else {
			await fastify.listen({ port: config.PORT, host: config.HOST });
			fastify.log.info({ port: config.PORT, host: config.HOST }, 'privos-cluster ready');
		}

		// Native reverse proxy (only in `native` mode). cloudflared terminates
		// TLS at the edge and forwards `*.<domain> → localhost:<PROXY_PORT>`.
		// Independent of the tunnel/listener choice above — it routes to
		// deployed app containers, not to this Fastify instance.
		if (config.REVERSE_PROXY_MODE === 'native') {
			await startReverseProxy();
			fastify.log.info({ proxyPort: config.PROXY_PORT }, 'native reverse proxy started');
		}
	} catch (err) {
		logFatal(err, 'failed to start');
		process.exit(1);
	}
}

/** Logs through the real Fastify logger once it exists; falls back to console for the narrow startup window before it does. */
function logFatal(err: unknown, msg: string): void {
	if (fastify) fastify.log.error(err, msg);
	else console.error(msg, err);
}

async function shutdown(signal: string): Promise<void> {
	fastify?.log.info({ signal }, 'shutdown initiated');
	try {
		if (networkSweepTimer) clearInterval(networkSweepTimer);
		stopHealthMonitor();
		tunnelClient?.stop();
		await mcpBrokerManager.closeAll();
		await stopReverseProxy();
		await fastify?.close();
		fastify?.log.info('shutdown complete');
		process.exit(0);
	} catch (err) {
		logFatal(err, 'shutdown error');
		process.exit(1);
	}
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
	logFatal(err, 'uncaughtException');
	process.exit(1);
});
process.on('unhandledRejection', (reason) => {
	logFatal(reason, 'unhandledRejection');
	process.exit(1);
});

void main();
