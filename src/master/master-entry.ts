import { loadMasterConfig } from './config.js';
import { connectMasterRepositories } from './repositories.js';
import { buildMasterServer } from './master-server.js';
import { KeyCipher } from './key-crypto.js';
import { AgentClient } from './agent-client.js';
import { ReconcileService } from './reconcile-service.js';
import { UsageAggregator, utcDay } from './usage-aggregator.js';

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

async function shutdown(signal: string): Promise<void> {
	server.log.info({ signal }, 'apps master shutdown');
	clearInterval(usageTimer);
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
