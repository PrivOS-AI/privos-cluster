import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { JsonWebKey } from 'node:crypto';
import { z } from 'zod';
import type { WorkspaceAuth } from './workspace-auth.js';
import { bearerFromHeader } from './workspace-auth.js';
import type { DeploymentService } from './deployment-service.js';
import type { AppLifecycleService } from './app-lifecycle-service.js';
import type { MasterRepositories } from './repositories.js';
import type { AgentClient, AgentResponse } from './agent-client.js';
import type { McpSecurityVerifier } from './mcp-security.js';
import { verifyMarketplaceReleaseAttestation } from './mcp-security.js';
import { jwkThumbprint, sha256, sha256Base64Url } from '../security/artifacts.js';
import { clusterMcpSafeReason, recordClusterMcpEvent } from '../services/mcp-observability.js';
import type { ClusterMasterIdentity } from './cluster-master-identity.js';
import type { McpUninstallServiceV3 } from './mcp-uninstall-service-v3.js';

const DispatchRpcSchema = z.object({
	jsonrpc: z.string().optional(),
	method: z.string(),
	params: z.unknown().optional(),
	id: z.union([z.string(), z.number()]).optional(),
});

const McpV3InstallBodySchema = z.object({
	deploymentGrantJws: z.string().min(1),
}).strict();

const McpV3UninstallBodySchema = z.object({
	lifecycleCommandJws: z.string().min(1),
	issuer: z.string().min(1).max(200),
	deploymentId: z.string().min(1).max(160),
	generationId: z.string().min(1).max(160),
	generationNumber: z.number().int().positive(),
	resourceManifestHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	runtimeResourceInventoryHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

const McpV3ReconfigureBodySchema = z.object({
	reconfigureCommandJws: z.string().min(1),
	issuer: z.string().min(1).max(200),
	deploymentId: z.string().min(1).max(160),
	generationId: z.string().min(1).max(160),
	generationNumber: z.number().int().positive(),
	clusterAppId: z.string().min(1).max(160),
	manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	resourceManifestHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	runtimeResourceInventoryHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

const McpV3UpgradeBodySchema = z.object({
	upgradeCommandJws: z.string().min(1),
	issuer: z.string().min(1).max(200),
	deploymentId: z.string().min(1).max(160),
	generationId: z.string().min(1).max(160),
	generationNumber: z.number().int().positive(),
	clusterAppId: z.string().min(1).max(160),
	mcpAppId: z.string().min(1).max(160),
	resourceManifestHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	runtimeResourceInventoryHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

const McpV3ActivationBodySchema = z.object({
	runtimeInventoryAttestation: z.object({
		compact: z.string().min(1),
		artifactHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	}).strict(),
}).strict();

const McpV3DispatchBodySchema = z.discriminatedUnion('authorizationContext', [
	z.object({
		assertion: z.string().min(1),
		rpc: DispatchRpcSchema,
		authorizationContext: z.literal('workspace'),
		runtimeInstallationId: z.string().min(1).max(160),
	}).strict(),
	z.object({
		assertion: z.string().min(1),
		rpc: DispatchRpcSchema,
		authorizationContext: z.literal('room'),
		runtimeInstallationId: z.string().min(1).max(160),
		authorizationBindingId: z.string().min(1).max(160),
	}).strict(),
]);

declare module 'fastify' {
	interface FastifyRequest {
		masterWorkspace?: { workspaceId: string; sub?: string };
	}
}

function workspaceId(req: FastifyRequest): string {
	return (req.params as { workspaceId: string }).workspaceId;
}

function appId(req: FastifyRequest): string {
	return (req.params as { appId: string }).appId;
}

function sendAgent(reply: FastifyReply, response: AgentResponse) {
	return reply.code(response.status).send(response.body);
}

export function hubFacingRoutes(deps: {
	auth: WorkspaceAuth;
	deployment: DeploymentService;
	lifecycle: AppLifecycleService;
	repositories: MasterRepositories;
	agentClient: AgentClient;
	baseDomain: string;
	mcpSecurity?: McpSecurityVerifier;
	mcpV2Enabled: boolean;
	mcpV3Enabled: boolean;
	/** Kill switch for the configuration-redeploy route; installs are unaffected. */
	mcpReconfigureEnabled: boolean;
	/** Kill switch for the in-place image-upgrade route; installs/reconfigures are unaffected. */
	mcpUpgradeEnabled: boolean;
	clusterMasterIdentity: ClusterMasterIdentity;
	mcpUninstall?: McpUninstallServiceV3;
	mcpReleaseAuthorityJwks: JsonWebKey[];
}): FastifyPluginAsync {
	return async (fastify) => {
		const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
			try {
				req.masterWorkspace = await deps.auth.verify(
					workspaceId(req),
					bearerFromHeader(req.headers.authorization),
				);
			} catch (error) {
				const statusCode = (error as { statusCode?: number }).statusCode ?? 401;
				return reply.code(statusCode).send({ error: (error as Error).message });
			}
		};
		const root = '/w/:workspaceId/api/v1';
		fastify.get(`${root}/health`, { preHandler: authenticate }, async () => ({
			status: 'ok',
			service: 'privos-apps-master',
		}));
		fastify.get(`${root}/auth/me`, { preHandler: authenticate }, async (req) => ({
			iss: 'privos-chat',
			sub: req.masterWorkspace?.sub,
			workspaceId: req.masterWorkspace?.workspaceId,
		}));
		fastify.get(`${root}/resources`, { preHandler: authenticate }, async (req, reply) => {
			const workspace = await deps.repositories.workspaces.findOne({
				workspaceId: workspaceId(req),
				status: 'ACTIVE',
			});
			return reply.send({ quota: workspace?.quota });
		});
		fastify.get(`${root}/cluster/resources`, { preHandler: authenticate }, async (req, reply) => {
			const workspace = await deps.repositories.workspaces.findOne({
				workspaceId: workspaceId(req),
				status: 'ACTIVE',
			});
			return reply.send({ quota: workspace?.quota });
		});
		fastify.get(`${root}/cluster/domains`, { preHandler: authenticate }, async () => ({
			domains: [deps.baseDomain],
			reverseProxyEnabled: true,
			mode: 'native',
		}));
		fastify.get(`${root}/cluster/subdomain-check`, { preHandler: authenticate }, async (req) => {
			const value = (req.query as { value?: string }).value;
			const exists = value ? await deps.repositories.apps.findOne({ subdomain: value }) : null;
			return { available: Boolean(value) && !exists };
		});
		fastify.post(`${root}/apps/deploy/validate`, { preHandler: authenticate }, async () => ({
			ok: true,
			checks: [{ id: 'master', label: 'Master scheduling', status: 'ok' }],
		}));
		fastify.post(`${root}/apps/deploy`, { preHandler: authenticate }, async (req, reply) => {
			const app = await deps.deployment.deploy(workspaceId(req), req.body);
			return reply.code(201).send({
				...app,
				id: app.appId,
				domain: deps.baseDomain,
			});
		});
		fastify.get(`${root}/apps`, { preHandler: authenticate }, async (req) =>
			deps.lifecycle.list(workspaceId(req)));
		fastify.get(`${root}/apps/:appId`, { preHandler: authenticate }, async (req) =>
			deps.lifecycle.get(workspaceId(req), appId(req)));
		for (const action of ['start', 'stop', 'restart'] as const) {
			fastify.post(
				`${root}/apps/:appId/${action}`,
				{ preHandler: authenticate },
				async (req) => deps.lifecycle.invoke(workspaceId(req), appId(req), action),
			);
		}
		fastify.get(`${root}/apps/:appId/status`, { preHandler: authenticate }, async (req, reply) =>
			sendAgent(reply, await deps.lifecycle.proxy(workspaceId(req), appId(req), 'GET', '/status')));
		fastify.get(`${root}/apps/:appId/logs`, { preHandler: authenticate }, async (req, reply) => {
			const query = new URLSearchParams(req.query as Record<string, string>).toString();
			return sendAgent(
				reply,
				await deps.lifecycle.proxy(
					workspaceId(req),
					appId(req),
					'GET',
					`/logs${query ? `?${query}` : ''}`,
				),
			);
		});
		fastify.post(`${root}/apps/:appId/dispatch`, { preHandler: authenticate }, async (req, reply) =>
		{
			const app = await deps.repositories.apps.findOne({ workspaceId: workspaceId(req), appId: appId(req), state: { $ne: 'REMOVED' } });
			if (!app) return reply.code(404).send({ error: 'app not found' });
			if (app.kind === 'mcp-v3') {
				if (!deps.mcpV3Enabled || !deps.mcpSecurity) {
					return reply.code(404).send({ error: 'mcp_install_v3_disabled' });
				}
				if (
					app.state !== 'RUNNING' ||
					!app.mcpInventoryAttestationEstablishedAt ||
					!app.mcpDeploymentId ||
					!app.mcpGenerationId ||
					!app.mcpGenerationNumber ||
					!app.mcpRuntimeInstallationId ||
					!app.mcpAppId ||
					!app.manifestDigest ||
					!app.mcpApprovalReceiptHash ||
					!app.mcpAuthorizationEpoch ||
					!app.resourceManifestHash ||
					!app.runtimeResourceInventoryHash
				) return reply.code(409).send({ error: 'mcp_v3_runtime_not_active' });
				const body = McpV3DispatchBodySchema.safeParse(req.body);
				if (!body.success) {
					return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
				}
				if (body.data.runtimeInstallationId !== app.mcpRuntimeInstallationId) {
					return reply.code(403).send({ error: 'mcp_dispatch_denied', code: 'GENERATION_AFFINITY_MISMATCH' });
				}
				try {
					await deps.mcpSecurity.consumeDispatchAssertionV3({
						compact: body.data.assertion,
						rpc: body.data.rpc,
						workspaceId: app.workspaceId,
						expected: {
							deploymentId: app.mcpDeploymentId,
							generationId: app.mcpGenerationId,
							generationNumber: app.mcpGenerationNumber,
							runtimeInstallationId: app.mcpRuntimeInstallationId,
							resourceManifestHash: app.resourceManifestHash,
							runtimeResourceInventoryHash: app.runtimeResourceInventoryHash,
							issuer: `urn:privos:hub:${app.mcpDeploymentId}`,
							manifestDigest: app.manifestDigest,
							runtimeApprovalReceiptHash: app.mcpApprovalReceiptHash,
							runtimeGrantEpoch: app.mcpAuthorizationEpoch,
							mcpAppId: app.mcpAppId!,
							clusterAppId: app.appId,
						},
						authorization: body.data,
					});
				} catch (error) {
					const reason = clusterMcpSafeReason(error, 'dispatch_assertion_invalid');
					recordClusterMcpEvent({
						event: 'private_dispatch', outcome: 'denied', boundary: 'master_v3', reason,
						correlationId: app.mcpRuntimeInstallationId,
					});
					return reply.code(403).send({
						error: 'mcp_dispatch_denied',
						code: reason,
					});
				}
				recordClusterMcpEvent({
					event: 'private_dispatch', outcome: 'allowed', boundary: 'master_v3', reason: 'verified',
					correlationId: app.mcpRuntimeInstallationId, emitLog: false,
				});
				const activeNodes = await deps.repositories.nodes.find({
					nodeId: { $in: app.replicas.map((replica) => replica.nodeId) },
					status: 'ACTIVE',
				}).toArray();
				const candidates = app.replicas.flatMap((replica) => {
					const node = activeNodes.find((candidate) => candidate.nodeId === replica.nodeId);
					return replica.state === 'running' && node ? [{ replica, node }] : [];
				});
				const health = await Promise.all(candidates.map(async (candidate) => {
					try {
						const response = await deps.agentClient.request(
							candidate.node,
							app.workspaceId,
							'GET',
							`/api/v1/apps/${candidate.replica.containerId}/status`,
						);
						const status = response.body as { state?: unknown; healthStatus?: unknown };
						return response.status < 300 && status.state === 'running' && status.healthStatus !== 'unhealthy'
							? candidate
							: null;
					} catch {
						return null;
					}
				}));
				const selected = health.find((candidate) => candidate !== null);
				if (!selected) {
					// This 409 was silent, and it was the only externally visible
					// symptom of a fleet-wide outage: every app container had gone
					// unhealthy because the tenant Hub never learned the node keys,
					// so nothing here could pair. Naming which gate emptied the
					// candidate set is the difference between "dispatch broken" and
					// a diagnosis.
					const reason = app.replicas.length === 0
						? 'no_replica'
						: candidates.length === 0
							? 'no_running_replica_on_active_node'
							: 'health_probe_failed';
					recordClusterMcpEvent({
						event: 'private_dispatch', outcome: 'denied', boundary: 'master_v3', reason,
						correlationId: app.mcpRuntimeInstallationId,
					});
					return reply.code(409).send({ error: 'replica_node_unavailable' });
				}
				return sendAgent(reply, await deps.agentClient.request(
					selected.node,
					app.workspaceId,
					'POST',
					`/api/v1/apps/${selected.replica.containerId}/dispatch`,
					{ ...body.data, runtimeResourceInventoryHash: app.runtimeResourceInventoryHash },
				));
			}
			if (app.kind !== 'mcp-v2') {
				return sendAgent(reply, await deps.lifecycle.proxy(workspaceId(req), appId(req), 'POST', '/dispatch', req.body));
			}
			if (!deps.mcpV2Enabled || !deps.mcpSecurity || app.state !== 'RUNNING' || !app.mcpInstallationId || !app.receiptHash || !app.grantEpoch) {
				return reply.code(409).send({ error: 'mcp_app_not_dispatchable' });
			}
			const body = req.body as { assertion?: string; rpc?: unknown };
			const replica = app.replicas[0];
			if (!replica || !body?.assertion || body.rpc === undefined) return reply.code(400).send({ error: 'invalid_mcp_dispatch' });
			let assertion: Awaited<ReturnType<McpSecurityVerifier['consumeDispatchAssertion']>>;
			try {
				assertion = await deps.mcpSecurity.consumeDispatchAssertion({
					compact: body.assertion,
					workspaceId: app.workspaceId,
					installationId: app.mcpInstallationId,
					clusterAppId: app.appId,
					replicaId: replica.replicaId,
					rpc: body.rpc,
				});
			} catch (error) {
				const reason = clusterMcpSafeReason(error, 'dispatch_assertion_invalid');
				recordClusterMcpEvent({ event: 'private_dispatch', outcome: 'denied', boundary: 'master', reason, correlationId: app.mcpInstallationId });
				return reply.code(403).send({ error: 'mcp_dispatch_denied', code: reason });
			}
			if (assertion.mcpAppId !== app.mcpAppId || assertion.receiptHash !== app.receiptHash || assertion.grantEpoch !== app.grantEpoch) {
				recordClusterMcpEvent({ event: 'private_dispatch', outcome: 'denied', boundary: 'master', reason: 'dispatch_binding_mismatch', correlationId: app.mcpInstallationId });
				return reply.code(403).send({ error: 'dispatch_assertion_binding_mismatch' });
			}
			recordClusterMcpEvent({ event: 'private_dispatch', outcome: 'allowed', boundary: 'master', reason: 'verified', correlationId: app.mcpInstallationId, emitLog: false });
			const node = await deps.repositories.nodes.findOne({ nodeId: replica.nodeId, status: 'ACTIVE' });
			if (!node) {
				recordClusterMcpEvent({
					event: 'private_dispatch', outcome: 'denied', boundary: 'master', reason: 'replica_node_inactive',
					correlationId: app.mcpInstallationId,
				});
				return reply.code(409).send({ error: 'replica_node_unavailable' });
			}
			return sendAgent(reply, await deps.agentClient.request(
				node,
				app.workspaceId,
				'POST',
				`/api/v1/apps/${replica.containerId}/dispatch`,
				body,
			));
		});
		fastify.post(`${root}/apps/:appId/redeploy`, { preHandler: authenticate }, async (req) =>
			deps.lifecycle.redeploy(workspaceId(req), appId(req), req.body as {
				image?: string;
				digest?: string;
				versionDigest?: string;
				resources?: { memoryMb?: number; cpus?: number; tmpSizeMb?: number };
			}));
		fastify.post(`${root}/apps/:appId/availability-tier`, { preHandler: authenticate }, async (req) => {
			const availabilityTier = (req.body as { availabilityTier?: string })?.availabilityTier;
			if (availabilityTier !== 'single' && availabilityTier !== 'ha') {
				const error: Error & { statusCode?: number } = new Error('availabilityTier must be single or ha');
				error.statusCode = 400;
				throw error;
			}
			return deps.deployment.changeAvailabilityTier(workspaceId(req), appId(req), availabilityTier);
		});
		fastify.delete(`${root}/apps/:appId`, { preHandler: authenticate }, async (req, reply) => {
			const app = await deps.repositories.apps.findOne({ workspaceId: workspaceId(req), appId: appId(req), state: { $ne: 'REMOVED' } });
			if (app?.kind === 'mcp-v2' || app?.kind === 'mcp-v3') {
				return reply.code(409).send({ error: 'mcp_revocation_required' });
			}
			await deps.lifecycle.remove(workspaceId(req), appId(req));
			return { ok: true };
		});
		fastify.post(`${root}/images/pull`, { preHandler: authenticate }, async (req, reply) => {
			const node = await deps.repositories.nodes.findOne({ status: 'ACTIVE' });
			if (!node) return reply.code(409).send({ error: 'CAPACITY_UNAVAILABLE' });
			return sendAgent(
				reply,
				await deps.agentClient.request(node, workspaceId(req), 'POST', '/api/v1/images/pull', req.body),
			);
		});

		fastify.post(`${root}/mcp/images/inspect`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.mcpSecurity) return reply.code(404).send({ error: 'mcp_install_v2_disabled' });
			const node = await deps.repositories.nodes.findOne({ status: 'ACTIVE' });
			if (!node) return reply.code(409).send({ error: 'CAPACITY_UNAVAILABLE' });
			const response = await deps.agentClient.request(node, workspaceId(req), 'POST', '/api/v1/mcp/images/inspect', req.body);
			if (response.status >= 300) return sendAgent(reply, response);
			return reply.send(response.body);
		});
		fastify.get(`${root}/mcp/v3/cluster-identity`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.mcpV3Enabled) return reply.code(404).send({ error: 'mcp_install_v3_disabled' });
			return deps.clusterMasterIdentity.publicInfo();
		});
		fastify.get(`${root}/mcp/v3/identity`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.mcpV3Enabled) return reply.code(404).send({ error: 'mcp_install_v3_disabled' });
			const identity = await deps.clusterMasterIdentity.publicInfo();
			return {
				protocolVersion: identity.protocolVersion,
				clusterId: identity.clusterId,
				issuer: identity.issuer,
				algorithm: identity.algorithm,
				kid: identity.kid,
				publicJwk: identity.publicJwk,
				artifactTypes: identity.artifactTypes,
			};
		});
		fastify.post(`${root}/mcp/identity/enroll`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.mcpSecurity) return reply.code(404).send({ error: 'mcp_install_v2_disabled' });
			const body = req.body as { proof?: unknown; publicJwk?: unknown };
			if (typeof body?.proof !== 'string' || !body.publicJwk || typeof body.publicJwk !== 'object') {
				return reply.code(400).send({ error: 'hub_identity_enrollment_invalid' });
			}
			try {
				return await deps.mcpSecurity.enrollHubIdentity({
					compact: body.proof,
					publicJwk: body.publicJwk as JsonWebKey,
					workspaceId: workspaceId(req),
				});
			} catch (error) {
				return reply.code(409).send({
					error: 'hub_identity_enrollment_rejected',
					code: clusterMcpSafeReason(error, 'hub_identity_enrollment_invalid'),
				});
			}
		});
		fastify.get(`${root}/mcp/identity`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.mcpSecurity) return reply.code(404).send({ error: 'mcp_install_v2_disabled' });
			const identity = await deps.mcpSecurity.publicInfo(workspaceId(req));
			return { clusterId: deps.mcpSecurity.clusterIdentity(), hubKid: identity?.kid ?? null };
		});
		fastify.get(`${root}/mcp/nodes/identities`, { preHandler: authenticate }, async (req, reply) => {
			const security = deps.mcpSecurity;
			if (!security) return reply.code(404).send({ error: 'mcp_install_v2_disabled' });
			const nodes = await deps.repositories.nodes.find({ status: { $ne: 'RETIRED' } }).toArray();
			const responses = await Promise.all(nodes.map(async (node) => ({
				node,
				response: await deps.agentClient.request(node, workspaceId(req), 'GET', '/api/v1/mcp/node-identity'),
			})));
			const identities = responses.map(({ node, response }) => {
				if (response.status >= 300 || !response.body || typeof response.body !== 'object') {
					throw Object.assign(new Error('mcp_node_identity_unavailable'), { statusCode: 503 });
				}
				const identity = response.body as { clusterId?: unknown; nodeId?: unknown; kid?: unknown; publicJwk?: unknown };
				if (
					identity.clusterId !== security.clusterIdentity() ||
					identity.nodeId !== node.nodeId ||
					typeof identity.kid !== 'string' ||
					!identity.publicJwk ||
					typeof identity.publicJwk !== 'object'
				) throw Object.assign(new Error('mcp_node_identity_invalid'), { statusCode: 409 });
				try {
					if (jwkThumbprint(identity.publicJwk as JsonWebKey) !== identity.kid) throw new Error('thumbprint mismatch');
				} catch {
					throw Object.assign(new Error('mcp_node_identity_invalid'), { statusCode: 409 });
				}
				return { nodeId: node.nodeId, kid: identity.kid, publicJwk: identity.publicJwk as JsonWebKey };
			});
			await Promise.all(identities.map((identity) => deps.repositories.nodes.updateOne(
				{ nodeId: identity.nodeId, status: { $ne: 'RETIRED' } },
				{ $set: { mcpIdentityKid: identity.kid, mcpIdentityPublicJwk: identity.publicJwk, updatedAt: new Date() } },
			)));
			return { clusterId: security.clusterIdentity(), nodes: identities };
		});

		fastify.post(`${root}/mcp/apps/install`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.mcpV2Enabled || !deps.mcpSecurity) return reply.code(404).send({ error: 'mcp_install_v2_disabled' });
			const compact = (req.body as { deploymentGrant?: string })?.deploymentGrant;
			if (!compact) return reply.code(400).send({ error: 'deployment_grant_required' });
			let grant: Awaited<ReturnType<McpSecurityVerifier['consumeDeploymentGrant']>>;
			try {
				grant = await deps.mcpSecurity.consumeDeploymentGrant(compact, workspaceId(req));
				recordClusterMcpEvent({ event: 'deployment_grant', outcome: 'allowed', boundary: 'master', reason: 'verified', correlationId: grant.installationId, emitLog: false });
			} catch (error) {
				const reason = clusterMcpSafeReason(error, 'deployment_grant_invalid');
				recordClusterMcpEvent({ event: 'deployment_grant', outcome: 'denied', boundary: 'master', reason });
				return reply.code(403).send({ error: 'deployment_grant_invalid', code: reason });
			}
			const node = await deps.repositories.nodes.findOne({ status: 'ACTIVE' });
			if (!node) return reply.code(409).send({ error: 'CAPACITY_UNAVAILABLE' });
			const inspectedResponse = await deps.agentClient.request(node, workspaceId(req), 'POST', '/api/v1/mcp/images/inspect', {
				image: grant.deployment.image,
				digest: grant.deployment.imageDigest,
			});
			if (inspectedResponse.status >= 300) return sendAgent(reply, inspectedResponse);
			const inspected = inspectedResponse.body as { imageDigest: string; manifestDigest: string };
			if (
				inspected.imageDigest !== grant.deployment.imageDigest ||
				inspected.manifestDigest !== grant.deployment.manifestDigest
			) {
				return reply.code(409).send({ error: 'inspected_artifact_binding_mismatch' });
			}
			verifyMarketplaceReleaseAttestation({
				compact: grant.deployment.releaseAttestationJws,
				trustedJwks: deps.mcpReleaseAuthorityJwks,
				listingId: grant.deployment.listingId,
				imageDigest: inspected.imageDigest,
				manifestDigest: inspected.manifestDigest,
			});
			let app: Awaited<ReturnType<DeploymentService['deployMcp']>>;
			try {
				const hubIdentity = await deps.mcpSecurity.publicInfo(workspaceId(req));
				if (!hubIdentity) return reply.code(409).send({ error: 'hub_identity_not_enrolled' });
				app = await deps.deployment.deployMcp(
					workspaceId(req),
					grant,
					sha256(compact),
					hubIdentity,
				);
				recordClusterMcpEvent({ event: 'provisioning', outcome: 'allowed', boundary: 'master', reason: 'scheduled', correlationId: grant.installationId });
			} catch (error) {
				recordClusterMcpEvent({ event: 'provisioning', outcome: 'denied', boundary: 'master', reason: clusterMcpSafeReason(error, 'deployment_failed'), correlationId: grant.installationId });
				throw error;
			}
			return reply.code(201).send({
				appId: app.appId,
				installationId: app.mcpInstallationId,
				state: app.state,
				uiUrl: app.uiUrl,
				replicas: app.replicas.map((replica) => ({
					replicaId: replica.replicaId,
					nodeId: replica.nodeId,
					containerId: replica.containerId,
					nodeIdentity: replica.mcpNodeIdentity,
				})),
			});
		});

		fastify.post(`${root}/mcp/v3/apps/install`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.mcpV3Enabled || !deps.mcpSecurity) {
				return reply.code(404).send({ error: 'mcp_install_v3_disabled' });
			}
			const body = McpV3InstallBodySchema.safeParse(req.body);
			if (!body.success) return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
			let grant: Awaited<ReturnType<McpSecurityVerifier['consumeProvisioningDeploymentGrantV3']>>;
			try {
				grant = await deps.mcpSecurity.consumeProvisioningDeploymentGrantV3({
					compact: body.data.deploymentGrantJws,
					workspaceId: workspaceId(req),
				});
			} catch (error) {
				return reply.code(403).send({
					error: 'deployment_grant_invalid',
					code: clusterMcpSafeReason(error, 'deployment_grant_invalid'),
				});
			}
			const node = await deps.repositories.nodes.findOne({ status: 'ACTIVE' });
			if (!node) return reply.code(409).send({ error: 'CAPACITY_UNAVAILABLE' });
			const inspectedResponse = await deps.agentClient.request(node, workspaceId(req), 'POST', '/api/v1/mcp/images/inspect', {
				image: grant.deployment.image,
				digest: grant.deployment.imageDigest,
			});
			if (inspectedResponse.status >= 300) return sendAgent(reply, inspectedResponse);
			const inspected = inspectedResponse.body as { imageDigest: string; manifestDigest: string };
			if (
				inspected.imageDigest !== grant.deployment.imageDigest ||
				inspected.manifestDigest !== grant.deployment.manifestDigest
			) return reply.code(409).send({ error: 'inspected_artifact_binding_mismatch' });
			verifyMarketplaceReleaseAttestation({
				compact: grant.deployment.releaseAttestationJws,
				trustedJwks: deps.mcpReleaseAuthorityJwks,
				listingId: grant.deployment.listingId,
				imageDigest: inspected.imageDigest,
				manifestDigest: inspected.manifestDigest,
			});
			const hubIdentity = await deps.mcpSecurity.publicInfo(workspaceId(req));
			if (!hubIdentity) return reply.code(409).send({ error: 'hub_identity_not_enrolled' });
			const { app, inventory } = await deps.deployment.deployMcpV3(
				workspaceId(req),
				grant,
				sha256Base64Url(body.data.deploymentGrantJws),
				hubIdentity,
			);
			const attestation = await deps.clusterMasterIdentity.signRuntimeInventoryAttestation({
				deploymentGrantJti: grant.jti,
				inventoryId: inventory.inventoryId,
			});
			return reply.code(201).send({
				state: 'PROVISIONING',
				clusterAppId: app.appId,
				runtimeInstallationId: grant.runtimeInstallationId,
				publicUrl: deps.deployment.publicUrlFor(app.subdomain),
				runtimeInventoryAttestation: {
					compact: attestation.compact,
					artifactHash: attestation.artifactHash,
					kid: attestation.kid,
				},
			});
		});

		/**
		 * Apply a new operator environment to a running generation.
		 *
		 * Additive to the install path: a Hub that predates the contract never
		 * calls it, and calling it can only ever change environment values — the
		 * image, permissions, and resources of the generation are untouchable
		 * here, and the response's acknowledgement is the Cluster's attested
		 * evidence of which configuration epoch is actually running.
		 */
		fastify.post(`${root}/mcp/v3/apps/:runtimeInstallationId/reconfigure`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.mcpV3Enabled || !deps.mcpSecurity || !deps.mcpReconfigureEnabled) {
				return reply.code(404).send({ error: 'mcp_reconfigure_v3_disabled' });
			}
			const body = McpV3ReconfigureBodySchema.safeParse(req.body);
			if (!body.success) return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
			const runtimeInstallationId = (req.params as { runtimeInstallationId: string }).runtimeInstallationId;
			let command;
			try {
				command = await deps.mcpSecurity.consumeReconfigureCommandV3({
					compact: body.data.reconfigureCommandJws,
					workspaceId: workspaceId(req),
					expected: {
						deploymentId: body.data.deploymentId,
						generationId: body.data.generationId,
						generationNumber: body.data.generationNumber,
						runtimeInstallationId,
						resourceManifestHash: body.data.resourceManifestHash,
						runtimeResourceInventoryHash: body.data.runtimeResourceInventoryHash,
						issuer: body.data.issuer,
						clusterAppId: body.data.clusterAppId,
						manifestDigest: body.data.manifestDigest,
					},
				});
			} catch (error) {
				return reply.code(403).send({
					error: 'reconfigure_command_invalid',
					code: clusterMcpSafeReason(error, 'reconfigure_command_invalid'),
				});
			}
			let applied;
			try {
				applied = await deps.deployment.reconfigureMcpV3(workspaceId(req), command);
			} catch (error) {
				recordClusterMcpEvent({
					event: 'provisioning',
					outcome: 'denied',
					boundary: 'master_reconfigure',
					reason: clusterMcpSafeReason(error, 'reconfigure_failed'),
					correlationId: runtimeInstallationId,
				});
				const acknowledgement = await deps.clusterMasterIdentity.signReconfigureAcknowledgement({
					operationId: command.operationId,
					clusterId: command.clusterId,
					workspaceId: command.workspaceId,
					deploymentId: command.deploymentId,
					generationId: command.generationId,
					generationNumber: command.generationNumber,
					runtimeInstallationId: command.runtimeInstallationId,
					clusterAppId: command.clusterAppId,
					manifestDigest: command.manifestDigest,
					resourceManifestHash: command.resourceManifestHash,
					runtimeResourceInventoryHash: command.runtimeResourceInventoryHash,
					configEpoch: command.configEpoch,
					state: 'FAILED',
					appliedKeys: [],
					appliedAt: null,
					errorCode: clusterMcpSafeReason(error, 'RECONFIGURE_FAILED').toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
				});
				return reply.code(409).send({
					state: 'FAILED',
					clusterAppId: command.clusterAppId,
					runtimeInstallationId: command.runtimeInstallationId,
					configEpoch: command.configEpoch,
					acknowledgement: {
						compact: acknowledgement.compact,
						artifactHash: acknowledgement.artifactHash,
						kid: acknowledgement.kid,
					},
				});
			}
			const acknowledgement = await deps.clusterMasterIdentity.signReconfigureAcknowledgement({
				operationId: command.operationId,
				clusterId: command.clusterId,
				workspaceId: command.workspaceId,
				deploymentId: command.deploymentId,
				generationId: command.generationId,
				generationNumber: command.generationNumber,
				runtimeInstallationId: command.runtimeInstallationId,
				clusterAppId: command.clusterAppId,
				manifestDigest: command.manifestDigest,
				resourceManifestHash: command.resourceManifestHash,
				runtimeResourceInventoryHash: command.runtimeResourceInventoryHash,
				configEpoch: command.configEpoch,
				state: 'APPLIED',
				appliedKeys: applied.appliedKeys,
				appliedAt: (applied.app.appliedConfigAt ?? new Date()).toISOString(),
				errorCode: null,
			});
			recordClusterMcpEvent({
				event: 'provisioning',
				outcome: 'changed',
				boundary: 'master_reconfigure',
				reason: 'reconfigured',
				correlationId: runtimeInstallationId,
			});
			return reply.code(200).send({
				state: 'RUNNING',
				clusterAppId: applied.app.appId,
				runtimeInstallationId,
				configEpoch: command.configEpoch,
				publicUrl: deps.deployment.publicUrlFor(applied.app.subdomain),
				acknowledgement: {
					compact: acknowledgement.compact,
					artifactHash: acknowledgement.artifactHash,
					kid: acknowledgement.kid,
				},
			});
		});

		/**
		 * Swap a running v3 generation to a new image under a signed, single-use
		 * Hub command. Unlike reconfigure, the target image is NEW, so its manifest
		 * label is verified against the pinned digest here — via the same
		 * `/mcp/images/inspect` check that gates installs — before the old runtime
		 * is touched at all. Only after that passes does the swap reach the agent.
		 */
		fastify.post(`${root}/mcp/v3/apps/:runtimeInstallationId/upgrade`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.mcpV3Enabled || !deps.mcpSecurity || !deps.mcpUpgradeEnabled) {
				return reply.code(404).send({ error: 'mcp_upgrade_v3_disabled' });
			}
			const body = McpV3UpgradeBodySchema.safeParse(req.body);
			if (!body.success) return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
			const runtimeInstallationId = (req.params as { runtimeInstallationId: string }).runtimeInstallationId;
			let command;
			try {
				command = await deps.mcpSecurity.consumeUpgradeCommandV3({
					compact: body.data.upgradeCommandJws,
					workspaceId: workspaceId(req),
					expected: {
						deploymentId: body.data.deploymentId,
						generationId: body.data.generationId,
						generationNumber: body.data.generationNumber,
						runtimeInstallationId,
						resourceManifestHash: body.data.resourceManifestHash,
						runtimeResourceInventoryHash: body.data.runtimeResourceInventoryHash,
						issuer: body.data.issuer,
						clusterAppId: body.data.clusterAppId,
						mcpAppId: body.data.mcpAppId,
					},
				});
			} catch (error) {
				return reply.code(403).send({
					error: 'upgrade_command_invalid',
					code: clusterMcpSafeReason(error, 'upgrade_command_invalid'),
				});
			}

			const app = await deps.repositories.apps.findOne({
				workspaceId: workspaceId(req),
				kind: 'mcp-v3',
				mcpRuntimeInstallationId: runtimeInstallationId,
				state: { $ne: 'REMOVED' },
			});
			if (!app) return reply.code(404).send({ error: 'mcp_v3_runtime_not_found' });

			// Every refusal/failure past this point signs an acknowledgement — the
			// Hub parses 409 bodies looking for one, and a bare `{error}` here
			// makes it dereference a missing field. `currentApp` is re-read rather
			// than trusting a snapshot taken before a slow operation (the swap
			// path especially — see the call below), falling back to it only if
			// the generation has genuinely disappeared between reads.
			const signRefusalAcknowledgement = async (
				state: 'REFUSED' | 'ROLLED_BACK' | 'FAILED',
				errorCode: string,
			) => {
				const currentApp = await deps.repositories.apps.findOne({
					workspaceId: workspaceId(req),
					kind: 'mcp-v3',
					mcpRuntimeInstallationId: runtimeInstallationId,
					state: { $ne: 'REMOVED' },
				}) ?? app;
				return deps.clusterMasterIdentity.signUpgradeAcknowledgement({
					operationId: command.operationId,
					clusterId: command.clusterId,
					workspaceId: command.workspaceId,
					deploymentId: command.deploymentId,
					generationId: command.generationId,
					generationNumber: command.generationNumber,
					revision: command.revision,
					runtimeInstallationId: command.runtimeInstallationId,
					clusterAppId: command.clusterAppId,
					runningManifestDigest: currentApp.manifestDigest ?? command.previousManifestDigest,
					runningImageDigest: currentApp.imageDigest ?? command.previousImageDigest,
					resourceManifestHash: command.resourceManifestHash,
					runtimeResourceInventoryHash: command.runtimeResourceInventoryHash,
					upgradeEpoch: command.upgradeEpoch,
					swapStrategy: currentApp.mcpLastSwapStrategy ?? 'STOP_THEN_CREATE',
					state,
					upgradedAt: null,
					errorCode,
				});
			};

			// The byte-exact check that gates installs, reused unchanged: pull +
			// inspect the NEW image and confirm its manifest label reduces to the
			// pinned digest before anything about the running container moves.
			// Neither branch below has touched a container — both are REFUSED.
			const node = await deps.repositories.nodes.findOne({ status: 'ACTIVE' });
			if (!node) {
				const acknowledgement = await signRefusalAcknowledgement('REFUSED', 'CAPACITY_UNAVAILABLE');
				return reply.code(409).send({
					state: 'REFUSED',
					error: 'CAPACITY_UNAVAILABLE',
					clusterAppId: command.clusterAppId,
					runtimeInstallationId: command.runtimeInstallationId,
					revision: command.revision,
					acknowledgement: {
						compact: acknowledgement.compact,
						artifactHash: acknowledgement.artifactHash,
						kid: acknowledgement.kid,
					},
				});
			}
			// `app.image` is pinned to the digest currently RUNNING, and an upgrade
			// exists precisely to move off it. `resolveImmutableImageReference`
			// refuses a reference whose existing pin disagrees with the requested
			// digest, so passing it verbatim fails every upgrade before any
			// container is touched. Install never hits this because the pin it
			// passes is the digest it is installing. Send the repository and let
			// the agent compose repository@targetImageDigest; the equality check
			// below still binds the answer to what the command authorized.
			const imageRepository = app.image.replace(/@sha256:[a-f0-9]{64}$/, '');
			const inspectedResponse = await deps.agentClient.request(node, workspaceId(req), 'POST', '/api/v1/mcp/images/inspect', {
				image: imageRepository,
				digest: command.targetImageDigest,
			});
			// An inspect failure happens BEFORE anything is touched, so it is a
			// refusal, not a failed swap. Signing REFUSED lets the Hub return the
			// installation to ACTIVE and end the operation retryably; a bare
			// passthrough leaves the saga stranded in RUNTIME_UPGRADING, where
			// every dispatch to the app is refused.
			if (inspectedResponse.status >= 300) {
				const acknowledgement = await signRefusalAcknowledgement('REFUSED', 'INSPECTED_ARTIFACT_UNAVAILABLE');
				return reply.code(409).send({
					error: 'inspected_artifact_unavailable',
					acknowledgement: {
						compact: acknowledgement.compact,
						artifactHash: acknowledgement.artifactHash,
						kid: acknowledgement.kid,
					},
				});
			}
			const inspected = inspectedResponse.body as { imageDigest: string; manifestDigest: string };
			if (
				inspected.imageDigest !== command.targetImageDigest ||
				inspected.manifestDigest !== command.targetManifestDigest
			) {
				const acknowledgement = await signRefusalAcknowledgement('REFUSED', 'INSPECTED_ARTIFACT_BINDING_MISMATCH');
				return reply.code(409).send({
					state: 'REFUSED',
					error: 'inspected_artifact_binding_mismatch',
					clusterAppId: command.clusterAppId,
					runtimeInstallationId: command.runtimeInstallationId,
					revision: command.revision,
					acknowledgement: {
						compact: acknowledgement.compact,
						artifactHash: acknowledgement.artifactHash,
						kid: acknowledgement.kid,
					},
				});
			}

			let applied;
			try {
				applied = await deps.deployment.upgradeMcpV3(workspaceId(req), command);
			} catch (error) {
				const errorCode = clusterMcpSafeReason(error, 'upgrade_failed');
				recordClusterMcpEvent({
					event: 'provisioning',
					outcome: 'denied',
					boundary: 'master_upgrade',
					reason: errorCode,
					correlationId: runtimeInstallationId,
				});
				// `upgradeMcpV3` tags an error with this code ONLY from inside the
				// try/catch that wraps the per-replica agent loop and the
				// persistence write — i.e. only once a container was actually
				// touched (or Mongo was). Every guard before that point (unknown
				// generation, stale epoch, app not RUNNING, ...) throws a plain or
				// McpProtocolV3Error with no such code, so this is an exact,
				// non-inferred signal that nothing was touched — not a guess based
				// on the error's message. See the schema doc on `state: 'REFUSED'`.
				const swapErrorCode = (error as { code?: unknown } | undefined)?.code;
				const touchedContainer =
					swapErrorCode === 'MCP_V3_UPGRADE_SWAP_FAILED' || swapErrorCode === 'MCP_V3_UPGRADE_PERSISTENCE_FAILED';
				const rolledBack = (error as { rolledBack?: unknown } | undefined)?.rolledBack === true;
				const state = !touchedContainer ? 'REFUSED' : rolledBack ? 'ROLLED_BACK' : 'FAILED';
				const acknowledgement = await signRefusalAcknowledgement(
					state,
					errorCode.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
				);
				return reply.code(409).send({
					state,
					clusterAppId: command.clusterAppId,
					runtimeInstallationId: command.runtimeInstallationId,
					revision: command.revision,
					acknowledgement: {
						compact: acknowledgement.compact,
						artifactHash: acknowledgement.artifactHash,
						kid: acknowledgement.kid,
					},
				});
			}
			const acknowledgement = await deps.clusterMasterIdentity.signUpgradeAcknowledgement({
				operationId: command.operationId,
				clusterId: command.clusterId,
				workspaceId: command.workspaceId,
				deploymentId: command.deploymentId,
				generationId: command.generationId,
				generationNumber: command.generationNumber,
				revision: command.revision,
				runtimeInstallationId: command.runtimeInstallationId,
				clusterAppId: command.clusterAppId,
				runningManifestDigest: applied.app.manifestDigest ?? command.targetManifestDigest,
				runningImageDigest: applied.app.imageDigest,
				resourceManifestHash: command.resourceManifestHash,
				runtimeResourceInventoryHash: command.runtimeResourceInventoryHash,
				upgradeEpoch: command.upgradeEpoch,
				swapStrategy: applied.swapStrategy,
				state: 'UPGRADED',
				upgradedAt: applied.app.updatedAt.toISOString(),
				errorCode: null,
			});
			recordClusterMcpEvent({
				event: 'provisioning',
				outcome: 'changed',
				boundary: 'master_upgrade',
				reason: 'upgraded',
				correlationId: runtimeInstallationId,
			});
			return reply.code(200).send({
				state: 'UPGRADED',
				clusterAppId: applied.app.appId,
				runtimeInstallationId,
				revision: command.revision,
				publicUrl: deps.deployment.publicUrlFor(applied.app.subdomain),
				acknowledgement: {
					compact: acknowledgement.compact,
					artifactHash: acknowledgement.artifactHash,
					kid: acknowledgement.kid,
				},
			});
		});

		/**
		 * Remove one runtime generation under a signed, single-use Hub command.
		 * The response carries the Cluster's signed acknowledgement, which can only
		 * claim completion when every declared resource is proven absent.
		 */
		fastify.post(`${root}/mcp/v3/apps/:runtimeInstallationId/uninstall`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.mcpV3Enabled || !deps.mcpSecurity || !deps.mcpUninstall) {
				return reply.code(404).send({ error: 'mcp_install_v3_disabled' });
			}
			const body = McpV3UninstallBodySchema.safeParse(req.body);
			if (!body.success) return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
			const runtimeInstallationId = (req.params as { runtimeInstallationId: string }).runtimeInstallationId;
			let command;
			try {
				command = await deps.mcpSecurity.consumeLifecycleCommandV3({
					compact: body.data.lifecycleCommandJws,
					workspaceId: workspaceId(req),
					expected: {
						deploymentId: body.data.deploymentId,
						generationId: body.data.generationId,
						generationNumber: body.data.generationNumber,
						runtimeInstallationId,
						resourceManifestHash: body.data.resourceManifestHash,
						runtimeResourceInventoryHash: body.data.runtimeResourceInventoryHash,
						issuer: body.data.issuer,
					},
				});
			} catch (error) {
				return reply.code(403).send({
					error: 'lifecycle_command_invalid',
					code: clusterMcpSafeReason(error, 'lifecycle_command_invalid'),
				});
			}
			const result = await deps.mcpUninstall.uninstall({
				workspaceId: workspaceId(req),
				command,
				commandHash: sha256Base64Url(body.data.lifecycleCommandJws),
			});
			return reply.code(result.state === 'COMPLETED' ? 200 : 409).send(result);
		});

		fastify.post(`${root}/mcp/v3/apps/:runtimeInstallationId/activate`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.mcpV3Enabled) return reply.code(404).send({ error: 'mcp_install_v3_disabled' });
			const body = McpV3ActivationBodySchema.safeParse(req.body);
			if (!body.success) return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
			const app = await deps.deployment.activateMcpV3(workspaceId(req), {
				runtimeInstallationId: (req.params as { runtimeInstallationId: string }).runtimeInstallationId,
				compact: body.data.runtimeInventoryAttestation.compact,
				artifactHash: body.data.runtimeInventoryAttestation.artifactHash,
			});
			if (!(app.mcpInventoryAttestationEstablishedAt instanceof Date)) {
				throw new Error('mcp_v3_activation_timestamp_missing');
			}
			const activatedAt = Math.floor(app.mcpInventoryAttestationEstablishedAt.getTime() / 1000);
			if (!Number.isSafeInteger(activatedAt) || activatedAt < 1) throw new Error('mcp_v3_activation_timestamp_invalid');
			// publicUrl deliberately does NOT appear here. A deployed Hub verifies
			// this response by exact key set, so an added field would fail every
			// activation between the Cluster release and the Hub release. The
			// install response — which no Hub shape-checks — carries it instead.
			return {
				state: 'RUNNING',
				clusterAppId: app.appId,
				runtimeInstallationId: app.mcpRuntimeInstallationId,
				activatedAt,
			};
		});

		fastify.post(`${root}/mcp/apps/:installationId/activate`, { preHandler: authenticate }, async (req) => {
			if (!deps.mcpV2Enabled || !deps.mcpSecurity) throw Object.assign(new Error('mcp_install_v2_disabled'), { statusCode: 404 });
			const body = req.body as { receiptHash?: string; grantEpoch?: number };
			return deps.deployment.activateMcp(workspaceId(req), {
				installationId: (req.params as { installationId: string }).installationId,
				receiptHash: String(body.receiptHash || ''),
				grantEpoch: Number(body.grantEpoch),
			});
		});

		fastify.post(`${root}/mcp/apps/:installationId/revoke`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.mcpV2Enabled || !deps.mcpSecurity) return reply.code(404).send({ error: 'mcp_install_v2_disabled' });
			const installationId = (req.params as { installationId: string }).installationId;
			const body = req.body as { receiptHash?: string; grantEpoch?: number };
			const app = await deps.repositories.apps.findOne({
				workspaceId: workspaceId(req),
				mcpInstallationId: installationId,
				kind: 'mcp-v2',
				state: { $ne: 'REMOVED' },
			});
			if (!app) return { ok: true, state: 'REMOVED' };
			if (app.receiptHash !== body.receiptHash || app.grantEpoch !== Number(body.grantEpoch)) {
				recordClusterMcpEvent({ event: 'provisioning', outcome: 'denied', boundary: 'master_revoke', reason: 'revocation_binding_mismatch', correlationId: installationId });
				return reply.code(403).send({ error: 'mcp_revocation_binding_mismatch' });
			}
			await deps.lifecycle.remove(workspaceId(req), app.appId);
			recordClusterMcpEvent({ event: 'provisioning', outcome: 'changed', boundary: 'master_revoke', reason: 'revoked', correlationId: installationId });
			return { ok: true, state: 'REMOVED' };
		});
	};
}
