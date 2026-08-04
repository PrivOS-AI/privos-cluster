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

const DispatchRpcSchema = z.object({
	jsonrpc: z.string().optional(),
	method: z.string(),
	params: z.unknown().optional(),
	id: z.union([z.string(), z.number()]).optional(),
});

const McpV3InstallBodySchema = z.object({
	deploymentGrantJws: z.string().min(1),
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
	clusterMasterIdentity: ClusterMasterIdentity;
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
				if (!selected) return reply.code(409).send({ error: 'replica_node_unavailable' });
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
			if (!node) return reply.code(409).send({ error: 'replica_node_unavailable' });
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
				runtimeInventoryAttestation: {
					compact: attestation.compact,
					artifactHash: attestation.artifactHash,
					kid: attestation.kid,
				},
			});
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
