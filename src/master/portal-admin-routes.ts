import crypto from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { WorkspaceClusterService } from './workspace-cluster-service.js';
import type { NodeRegistry } from './node-registry.js';
import type { MasterRepositories } from './repositories.js';
import type { AppLifecycleService } from './app-lifecycle-service.js';
import type { UsageAggregator } from './usage-aggregator.js';
import { utcDay } from './usage-aggregator.js';
import type { AppHostRegistry } from './app-host-registry.js';

const ReserveHostSchema = z.object({
	hostname: z.string().min(1).max(253),
	kind: z.enum(['TENANT', 'VANITY', 'CUSTOM']),
	listingId: z.string().min(1).max(128),
}).strict();

const DesiredHostSchema = z.object({
	hostname: z.string().min(1).max(253),
	kind: z.enum(['TENANT', 'VANITY', 'CUSTOM']),
	primary: z.boolean(),
	state: z.enum(['ACTIVE', 'SUSPENDED']),
}).strict();

const SetHostsSchema = z.object({
	listingId: z.string().min(1).max(128),
	generationId: z.string().min(1).max(160).optional(),
	hosts: z.array(DesiredHostSchema).max(20),
}).strict();

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
	// Absent = RUNTIME (every node registered before public-hostnames rolled
	// only ever ran app containers) — the Portal sends both for an APPS node.
	role: z.enum(['INGRESS', 'RUNTIME', 'BOTH']).optional(),
	meshIp: z.string().min(1).max(64).optional(),
	// The INGRESS/BOTH node's own Ed25519 signing public key, generated locally
	// at edge setup and registered here so the publisher can hand it to RUNTIME
	// nodes as the key that verifies a forwarded request.
	ingressSigningKid: z.string().min(1).max(128).optional(),
	ingressSigningPublicJwk: z
		.object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string().min(1) })
		.passthrough()
		.optional(),
});

const SlugSchema = z.object({ slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/) });

export function portalAdminRoutes(deps: {
	serviceKey: string;
	workspaces: WorkspaceClusterService;
	nodes: NodeRegistry;
	repositories: MasterRepositories;
	lifecycle: AppLifecycleService;
	usage: UsageAggregator;
	/** D-requirement registry. Optional so an unwired deployment (tests, a
	 * fleet that has not deployed phase 3) never loses the rest of this route
	 * set — only the hosts routes below need it. */
	appHosts?: AppHostRegistry;
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
		// C: sets ONLY slug — never routed through `upsertWorkspace`, and refuses
		// (404) a workspace that is not ACTIVE rather than silently creating one.
		fastify.patch(`${root}/workspaces/:workspaceId/slug`, { preHandler: authenticate }, async (req, reply) => {
			const { workspaceId } = req.params as { workspaceId: string };
			const { slug } = SlugSchema.parse(req.body);
			try {
				await deps.workspaces.setSlug(workspaceId, slug);
			} catch {
				return reply.code(404).send({ error: 'workspace not found' });
			}
			req.log.info({ workspaceId, slug }, 'apps master workspace slug set');
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
			// Revocation is Portal-owned: the tenant, its Hub and every app go together, so
			// v3 apps are removed here without the signed Hub command they need in life.
			for (const app of apps) await deps.lifecycle.remove(workspaceId, app.appId, { workspaceRevoked: true });
			await deps.workspaces.revoke(workspaceId);
			req.log.info({ workspaceId }, 'apps master workspace revoked');
			return { ok: true };
		});
		// Workspace power, driven by the Portal because the Portal owns the
		// billing state that suspends a tenant. Stop/start only — the app's
		// identity, entitlement and bindings are untouched, which is why this is
		// not subject to the signed-Hub-command rule that governs v3 lifecycle.
		fastify.post(`${root}/workspaces/:workspaceId/power`, { preHandler: authenticate }, async (req) => {
			const { workspaceId } = z.object({ workspaceId: z.string().min(1) }).parse(req.params);
			const { action } = z.object({ action: z.enum(['suspend', 'resume']) }).parse(req.body);
			const result = await deps.lifecycle.setWorkspacePower(workspaceId, action);
			req.log.info({ workspaceId, action, affected: result.affected }, 'apps master workspace power changed');
			return result;
		});
		// D: public-hostname registry. Service-key only (the `authenticate`
		// preHandler shared by this whole route set) — a Hub bearer token is a
		// workspace-scoped JWT, never the raw service key, so it always fails
		// the `timingSafeEqual` above and gets a 401, exactly like every other
		// admin route.
		fastify.post(`${root}/workspaces/:workspaceId/apps/:appId/hosts/reserve`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.appHosts) return reply.code(404).send({ error: 'app_host_registry_disabled' });
			const { workspaceId, appId } = req.params as { workspaceId: string; appId: string };
			const body = ReserveHostSchema.safeParse(req.body);
			if (!body.success) return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
			try {
				const row = await deps.appHosts.reserve({
					workspaceId,
					appId,
					listingId: body.data.listingId,
					hostname: body.data.hostname,
					kind: body.data.kind,
				});
				return reply.code(201).send(row);
			} catch (error) {
				const code = (error as { code?: string }).code ?? 'HOST_RESERVE_FAILED';
				return reply.code((error as { statusCode?: number }).statusCode ?? 409).send({ error: code });
			}
		});
		fastify.put(`${root}/workspaces/:workspaceId/apps/:appId/hosts`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.appHosts) return reply.code(404).send({ error: 'app_host_registry_disabled' });
			const { workspaceId, appId } = req.params as { workspaceId: string; appId: string };
			const body = SetHostsSchema.safeParse(req.body);
			if (!body.success) return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
			try {
				const rows = await deps.appHosts.setDesiredHosts({
					workspaceId,
					appId,
					listingId: body.data.listingId,
					generationId: body.data.generationId,
					hosts: body.data.hosts,
				});
				return reply.send({ hosts: rows });
			} catch (error) {
				const code = (error as { code?: string }).code ?? 'HOST_SET_FAILED';
				return reply.code((error as { statusCode?: number }).statusCode ?? 409).send({ error: code, hostname: (error as { hostname?: string }).hostname });
			}
		});
		fastify.get(`${root}/workspaces/:workspaceId/apps/:appId/hosts`, { preHandler: authenticate }, async (req, reply) => {
			if (!deps.appHosts) return reply.code(404).send({ error: 'app_host_registry_disabled' });
			const { workspaceId, appId } = req.params as { workspaceId: string; appId: string };
			return reply.send({ hosts: await deps.appHosts.get(workspaceId, appId) });
		});
		fastify.get(`${root}/apps`, { preHandler: authenticate }, async (req) => {
			const { workspaceId } = z.object({ workspaceId: z.string().min(1).optional() }).parse(req.query);
			const apps = await deps.repositories.apps
				.find(workspaceId ? { workspaceId } : {}, { projection: { envVars: 0 } })
				.toArray();
			// The portal billing/quota gate needs resources, replica count and
			// lifecycle timestamps per app; the raw find already carries them
			// (minus envVars), `replicaCount` is added for convenience so the
			// caller doesn't need to know the replicas array shape.
			return apps.map((app) => ({ ...app, replicaCount: app.replicas.length }));
		});
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
