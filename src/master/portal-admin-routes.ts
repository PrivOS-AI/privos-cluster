import crypto from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { WorkspaceClusterService } from './workspace-cluster-service.js';
import type { NodeRegistry } from './node-registry.js';
import type { MasterRepositories } from './repositories.js';
import type { AppLifecycleService } from './app-lifecycle-service.js';
import type { UsageAggregator } from './usage-aggregator.js';
import { utcDay } from './usage-aggregator.js';

const QuotaSchema = z.object({
	maxMemoryMb: z.number().int().positive(),
	maxCpus: z.number().positive(),
	maxApps: z.number().int().positive(),
});
const WorkspaceSchema = z.object({
	workspaceId: z.string().regex(/^[A-Za-z0-9-]+$/),
	key: z.string().min(24),
	quota: QuotaSchema,
	defaultAvailabilityTier: z.enum(['single', 'ha']).default('single'),
});
const NodeSchema = z.object({
	nodeId: z.string().regex(/^[A-Za-z0-9-]+$/),
	portalNodeId: z.string().optional(),
	url: z.string().url(),
	region: z.string().min(1),
	failureDomain: z.string().min(1),
	capacity: z.object({
		memoryMb: z.number().int().positive(),
		cpus: z.number().positive(),
		diskBytes: z.number().int().positive(),
	}),
	fleetKey: z.string().min(32),
	keyId: z.string().optional(),
	tunnelId: z.string().optional(),
	status: z.enum(['ACTIVE', 'DRAINING', 'RETIRED']).default('ACTIVE'),
});

export function portalAdminRoutes(deps: {
	serviceKey: string;
	workspaces: WorkspaceClusterService;
	nodes: NodeRegistry;
	repositories: MasterRepositories;
	lifecycle: AppLifecycleService;
	usage: UsageAggregator;
}): FastifyPluginAsync {
	return async (fastify) => {
		const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
			const provided = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
			const expected = Buffer.from(deps.serviceKey);
			const actual = Buffer.from(provided);
			if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
				return reply.code(401).send({ error: 'unauthorized' });
			}
		};
		const root = '/admin/v1';
		fastify.post(`${root}/workspaces`, { preHandler: authenticate }, async (req, reply) => {
			const input = WorkspaceSchema.parse(req.body);
			await deps.workspaces.upsert(input);
			req.log.info({ workspaceId: input.workspaceId }, 'apps master workspace upserted');
			return reply.code(201).send({ ok: true });
		});
		fastify.put(`${root}/workspaces/:workspaceId/key`, { preHandler: authenticate }, async (req) => {
			const { workspaceId } = req.params as { workspaceId: string };
			const { key } = z.object({ key: z.string().min(24) }).parse(req.body);
			await deps.workspaces.rotateKey(workspaceId, key);
			req.log.info({ workspaceId }, 'apps master workspace key rotated');
			return { ok: true };
		});
		fastify.put(`${root}/workspaces/:workspaceId/quota`, { preHandler: authenticate }, async (req) => {
			const { workspaceId } = req.params as { workspaceId: string };
			await deps.workspaces.updateQuota(workspaceId, QuotaSchema.parse(req.body));
			return { ok: true };
		});
		fastify.get(`${root}/workspaces/:workspaceId`, { preHandler: authenticate }, async (req, reply) => {
			const { workspaceId } = req.params as { workspaceId: string };
			const workspace = await deps.repositories.workspaces.findOne({ workspaceId });
			if (!workspace) return reply.code(404).send({ error: 'not found' });
			const appCount = await deps.repositories.apps.countDocuments({
				workspaceId,
				state: { $ne: 'REMOVED' },
			});
			return reply.send({
				workspaceId,
				status: workspace.status,
				quota: workspace.quota,
				defaultAvailabilityTier: workspace.defaultAvailabilityTier,
				appCount,
			});
		});
		fastify.delete(`${root}/workspaces/:workspaceId`, { preHandler: authenticate }, async (req) => {
			const { workspaceId } = req.params as { workspaceId: string };
			const apps = await deps.repositories.apps.find({
				workspaceId,
				state: { $ne: 'REMOVED' },
			}).toArray();
			for (const app of apps) await deps.lifecycle.remove(workspaceId, app.appId);
			await deps.workspaces.revoke(workspaceId);
			req.log.info({ workspaceId }, 'apps master workspace revoked');
			return { ok: true };
		});
		fastify.get(`${root}/apps`, { preHandler: authenticate }, async () =>
			deps.repositories.apps.find({}, { projection: { envVars: 0 } }).toArray());
		fastify.post(`${root}/usage/rollup`, { preHandler: authenticate }, async (req) => {
			const { date } = z.object({ date: z.string().date() }).parse(req.body);
			return deps.usage.rollup(utcDay(date));
		});
		fastify.get(`${root}/usage`, { preHandler: authenticate }, async (req) => {
			const query = z.object({
				date: z.string().date(),
				workspaceId: z.string().optional(),
			}).parse(req.query);
			return deps.repositories.usageDaily.find({
				date: utcDay(query.date),
				...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
			}).toArray();
		});
		fastify.post(`${root}/nodes`, { preHandler: authenticate }, async (req, reply) => {
			const input = NodeSchema.parse(req.body);
			const health = await fetch(`${input.url.replace(/\/$/, '')}/api/v1/health`, {
				signal: AbortSignal.timeout(5_000),
			});
			if (!health.ok) return reply.code(400).send({ error: 'node health check failed' });
			await deps.nodes.upsert(input);
			req.log.info({ nodeId: input.nodeId }, 'apps master node upserted');
			return reply.code(201).send({ ok: true });
		});
		fastify.get(`${root}/nodes`, { preHandler: authenticate }, async () =>
			deps.repositories.nodes.find({}, { projection: { encryptedFleetKey: 0 } }).toArray());
		fastify.patch(`${root}/nodes/:nodeId/status`, { preHandler: authenticate }, async (req) => {
			const { nodeId } = req.params as { nodeId: string };
			const { status } = z.object({
				status: z.enum(['ACTIVE', 'DRAINING', 'RETIRED']),
			}).parse(req.body);
			await deps.nodes.setStatus(nodeId, status);
			req.log.info({ nodeId, status }, 'apps master node status changed');
			return { ok: true };
		});
	};
}
