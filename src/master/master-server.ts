import Fastify from 'fastify';
import type { JsonWebKey } from 'node:crypto';
import type { MasterConfig } from './config.js';
import type { MasterRepositories } from './repositories.js';
import { KeyCipher } from './key-crypto.js';
import { WorkspaceAuth } from './workspace-auth.js';
import { AgentClient } from './agent-client.js';
import { IngressRouteProgrammer } from './ingress-route-programmer.js';
import { WorkspaceClusterService } from './workspace-cluster-service.js';
import { NodeRegistry } from './node-registry.js';
import { WorkspaceLock } from './workspace-lock.js';
import { QuotaService } from './quota-service.js';
import { SubdomainRegistry } from './subdomain-registry.js';
import { DeploymentService } from './deployment-service.js';
import { AppLifecycleService } from './app-lifecycle-service.js';
import { hubFacingRoutes } from './hub-facing-routes.js';
import { portalAdminRoutes } from './portal-admin-routes.js';
import { UsageAggregator } from './usage-aggregator.js';
import { McpSecurityVerifier } from './mcp-security.js';

export function buildMasterServer(config: MasterConfig, repositories: MasterRepositories) {
	const fastify = Fastify({ logger: { level: config.MASTER_LOG_LEVEL }, trustProxy: true });
	const cipher = new KeyCipher(Buffer.from(config.APP_MASTER_KEY_ENCRYPTION_KEY_B64, 'base64'));
	const agentClient = new AgentClient(cipher);
	const ingress = new IngressRouteProgrammer({
		enabled: config.APPS_INGRESS_ENABLED,
		zoneId: config.CF_APPS_ZONE_ID,
		apiToken: config.CF_APPS_API_TOKEN,
		baseDomain: config.APPS_BASE_DOMAIN,
	});
	const lifecycle = new AppLifecycleService({ repositories, agentClient, ingress });
	const usage = new UsageAggregator(repositories);
	const deployment = new DeploymentService({
		repositories,
		agentClient,
		ingress,
		quota: new QuotaService(repositories),
		subdomains: new SubdomainRegistry(repositories),
		locks: new WorkspaceLock(),
		baseDomain: config.APPS_BASE_DOMAIN,
	});
	const mcpSecurity = config.APP_CLUSTER_MCP_INSTALL_V2 === 'on'
		? new McpSecurityVerifier(repositories, config.APP_MASTER_CLUSTER_ID)
		: undefined;
	fastify.get('/health', async () => ({
		status: 'ok',
		service: 'privos-apps-master',
		uptime: Math.floor(process.uptime()),
	}));
	fastify.register(hubFacingRoutes({
		auth: new WorkspaceAuth(repositories, cipher),
		deployment,
		lifecycle,
		repositories,
		agentClient,
		baseDomain: config.APPS_BASE_DOMAIN,
		mcpSecurity,
		mcpReleaseAuthorityJwks: (JSON.parse(config.MCP_RELEASE_AUTHORITY_JWKS_JSON) as { keys: JsonWebKey[] }).keys,
	}));
	fastify.register(portalAdminRoutes({
		serviceKey: config.APP_MASTER_SERVICE_KEY,
		workspaces: new WorkspaceClusterService(repositories, cipher),
		nodes: new NodeRegistry(repositories, cipher),
		repositories,
		lifecycle,
		usage,
	}));
	fastify.setErrorHandler((error, req, reply) => {
		req.log.error({ err: error }, 'apps master request failed');
		const typed = error as { code?: string; statusCode?: number; message?: string };
		const code = typed.code;
		const message = typed.message ?? 'internal error';
		const statusCode = typed.statusCode ??
			(code?.includes('QUOTA') || code?.includes('CAPACITY') || code?.startsWith('HA_') ? 409 : 500);
		return reply.code(statusCode).send({ error: code ?? message, message });
	});
	return fastify;
}
