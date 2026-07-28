import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { WorkspaceAuth } from './workspace-auth.js';
import { bearerFromHeader } from './workspace-auth.js';
import type { DeploymentService } from './deployment-service.js';
import type { AppLifecycleService } from './app-lifecycle-service.js';
import type { MasterRepositories } from './repositories.js';
import type { AgentClient, AgentResponse } from './agent-client.js';

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
			sendAgent(
				reply,
				await deps.lifecycle.proxy(workspaceId(req), appId(req), 'POST', '/dispatch', req.body),
			));
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
		fastify.delete(`${root}/apps/:appId`, { preHandler: authenticate }, async (req) => {
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
	};
}
