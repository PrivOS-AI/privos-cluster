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
import { ClusterMasterIdentity } from './cluster-master-identity.js';
import { McpUninstallServiceV3 } from './mcp-uninstall-service-v3.js';

/** `body.error` is a wire contract: bounded, upper-snake, never the raw text underneath. */
const BOUNDED_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
/** Matches the ids already threaded end to end: `operationId` and `generationId`. */
const CORRELATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FALLBACK_ERROR_CODE = 'INTERNAL_ERROR';

/**
 * The reason token this service throws is lowercase snake_case (e.g. `duplicate_app_row`,
 * `mcp_node_identity_unavailable`) — the same convention `clusterMcpSafeReason` uppercases
 * before it reaches a signed acknowledgement.
 *
 * It arrives in one of TWO places, which is why both are candidates: a tagged error carries
 * it on `code`, but most of this service's throw sites carry no `code` at all and use the
 * token AS the message (`throw new Error('mcp_node_identity_unavailable')`). Reading only
 * `code` would collapse every one of those to the fallback and strip the Hub of a reason it
 * already consumes and classifies.
 *
 * Candidates are MATCHED, never rewritten — the repo's own `safeCode` works the same way.
 * Rewriting would let free text masquerade as a code: `"Some error happened"` would become
 * `SOME_ERROR_HAPPENED`. Requiring the token shape up front is what keeps raw text out —
 * a Mongo `E11000 duplicate key error collection: …` or `connect ECONNREFUSED 10.88.0.11:5000`
 * contains spaces, dots and colons, fails the pattern, and falls through to the fallback.
 * Mongo's own `code` is a NUMBER (11000), so it is never a string candidate either.
 */
const RAW_REASON_CODE = /^[a-z][a-z0-9_]{1,127}$/;
function boundedErrorCode(code: unknown, message?: unknown): string | undefined {
	const candidate = [code, message].find(
		(value): value is string => typeof value === 'string' && RAW_REASON_CODE.test(value.toLowerCase()),
	);
	return candidate ? candidate.toUpperCase() : undefined;
}

/**
 * Turn a thrown value into the status and body the Hub sees.
 *
 * `error` is ALWAYS a bounded code, never raw exception text — that is the behavioural
 * change. Before this, an untagged error fell back to `message` verbatim (`code ?? message`),
 * which is exactly how a Mongo E11000 (whose `code` is a NUMBER, not a string) reached the Hub
 * as an opaque wall of driver text and surfaced only as a bare `AUTO_FINALIZATION_FAILED`.
 * `message` keeps the raw text on purpose — it crosses only to the Hub's logs, truncated, and
 * is never forwarded past it; sanitizing it away here would throw out the one diagnostic payload
 * this response carries.
 *
 * `correlationId` is passthrough only: a failure class tagged with one at its throw site
 * (deployment-service's typed errors, or a route's `withCorrelationId` wrapper) echoes it here
 * so the Cluster's own log line — and anyone reading this response — can grep the same id the
 * Hub and Portal already have. An untagged error carries none.
 */
export function masterErrorResponse(error: unknown): {
	statusCode: number;
	body: { error: string; message: string; correlationId?: string };
} {
	const typed = error as { code?: unknown; statusCode?: number; message?: string; correlationId?: unknown };
	const code = boundedErrorCode(typed.code, typed.message);
	const message = typed.message ?? 'internal error';
	const correlationId =
		typeof typed.correlationId === 'string' && CORRELATION_ID.test(typed.correlationId)
			? typed.correlationId
			: undefined;
	const statusCode =
		typed.statusCode ??
		(code?.includes('QUOTA') || code?.includes('CAPACITY') || code?.startsWith('HA_') ? 409 : 500);
	return {
		statusCode,
		body: { error: code ?? FALLBACK_ERROR_CODE, message, ...(correlationId ? { correlationId } : {}) },
	};
}

export function buildMasterServer(config: MasterConfig, repositories: MasterRepositories) {
	const fastify = Fastify({ logger: { level: config.MASTER_LOG_LEVEL }, trustProxy: true });
	const cipher = new KeyCipher(Buffer.from(config.APP_MASTER_KEY_ENCRYPTION_KEY_B64, 'base64'));
	const agentClient = new AgentClient(cipher);
	const clusterMasterIdentity = new ClusterMasterIdentity(repositories, cipher, config.APP_MASTER_CLUSTER_ID);
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
		cipher,
	});
	const mcpSecurity = config.APP_CLUSTER_MCP_INSTALL_V2 === 'on' || config.APP_CLUSTER_MCP_INSTALL_V3 === 'on'
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
		mcpV2Enabled: config.APP_CLUSTER_MCP_INSTALL_V2 === 'on',
		mcpV3Enabled: config.APP_CLUSTER_MCP_INSTALL_V3 === 'on',
		mcpReconfigureEnabled: config.APP_CLUSTER_MCP_RECONFIGURE_V3 === 'on',
		mcpUpgradeEnabled: config.APP_CLUSTER_MCP_UPGRADE_V3 === 'on',
		clusterMasterIdentity,
		mcpUninstall: config.APP_CLUSTER_MCP_INSTALL_V3 === 'on'
			? new McpUninstallServiceV3({
				repositories,
				agentClient,
				ingress,
				clusterMasterIdentity,
				clusterId: config.APP_MASTER_CLUSTER_ID,
			})
			: undefined,
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
		const { statusCode, body } = masterErrorResponse(error);
		// `body.correlationId` is already the safe, extracted value (undefined when the
		// failure was never tagged) — log the same one the Hub sees, not the raw error.
		req.log.error({ err: error, correlationId: body.correlationId }, 'apps master request failed');
		return reply.code(statusCode).send(body);
	});
	return fastify;
}
