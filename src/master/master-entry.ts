import { loadMasterConfig } from './config.js';
import { connectMasterRepositories } from './repositories.js';
import { buildMasterServer } from './master-server.js';
import { KeyCipher } from './key-crypto.js';
import { AgentClient } from './agent-client.js';
import { ReconcileService } from './reconcile-service.js';
import { UsageAggregator, utcDay } from './usage-aggregator.js';
import { AppLifecycleService } from './app-lifecycle-service.js';
import { IngressRouteProgrammer } from './ingress-route-programmer.js';
import { reapExpiredQuarantines, resolveQuarantineGraceMs } from './quarantine-reaper.js';

const config = loadMasterConfig();
const { client, repositories } = await connectMasterRepositories(
	config.MASTER_MONGODB_URL,
	config.MASTER_MONGODB_DB,
);
const server = buildMasterServer(config, repositories);
const reconcile = new ReconcileService({
	repositories,
	agentClient: new AgentClient(
		new KeyCipher(Buffer.from(config.APP_MASTER_KEY_ENCRYPTION_KEY_B64, 'base64')),
	),
	baseDomain: config.APPS_BASE_DOMAIN,
});
const reconcileResult = await reconcile.run();
server.log.info(reconcileResult, 'apps master boot reconcile complete');
const usage = new UsageAggregator(repositories);
await Promise.all([
	usage.rollup(utcDay(new Date(Date.now() - 86_400_000))),
	usage.rollup(utcDay(new Date())),
]);
const usageTimer = setInterval(() => {
	void usage.rollup(utcDay(new Date())).catch((error) => server.log.error({ err: error }, 'apps usage rollup failed'));
}, 60 * 60 * 1000);
usageTimer.unref();

// Delayed reaper: permanently remove app workloads that have been QUARANTINED
// (workspace revoked/offboarded/purged) longer than the grace window. Runs once
// at boot and hourly thereafter; each app is reaped independently.
const reaperLifecycle = new AppLifecycleService({
	repositories,
	agentClient: new AgentClient(new KeyCipher(Buffer.from(config.APP_MASTER_KEY_ENCRYPTION_KEY_B64, 'base64'))),
	ingress: new IngressRouteProgrammer({
		enabled: config.APPS_INGRESS_ENABLED,
		zoneId: config.CF_APPS_ZONE_ID,
		apiToken: config.CF_APPS_API_TOKEN,
		baseDomain: config.APPS_BASE_DOMAIN,
	}),
});
const quarantineGraceMs = resolveQuarantineGraceMs();
const runReaper = () =>
	reapExpiredQuarantines(repositories, reaperLifecycle, { graceMs: quarantineGraceMs, log: server.log })
		.then((result) => {
			if (result.scanned > 0) server.log.info(result, 'quarantine reaper tick');
		})
		.catch((error) => server.log.error({ err: error }, 'quarantine reaper tick failed'));
await runReaper();
const reaperTimer = setInterval(() => void runReaper(), 60 * 60 * 1000);
reaperTimer.unref();

async function shutdown(signal: string): Promise<void> {
	server.log.info({ signal }, 'apps master shutdown');
	clearInterval(usageTimer);
	clearInterval(reaperTimer);
	await server.close();
	await client.close();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		void shutdown(signal).finally(() => process.exit(0));
	});
}

await server.listen({ host: config.MASTER_HOST, port: config.MASTER_PORT });
server.log.info({ host: config.MASTER_HOST, port: config.MASTER_PORT }, 'apps master ready');
