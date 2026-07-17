/**
 * Image build REST routes.
 * All routes require JWT auth via fastify.authenticate preHandler.
 *
 * Provides:
 * - POST /api/v1/images/build - Build image from Dockerfile with SSE streaming
 * - GET /api/v1/images/builds - List build history
 * - GET /api/v1/images/builds/:buildId - Get build details
 * - POST /api/v1/images/build/validate - Validate Dockerfile without building
 * - GET /api/v1/images/build/templates - List Dockerfile templates
 * - GET /api/v1/images/build/templates/:templateId - Get specific template
 */
import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import * as buildsRepo from '../db/builds-repo.js';
import * as imagesRepo from '../db/images-repo.js';
import { imageManager } from '../docker/index.js';
import {
	BuildIdParamSchema,
	BuildImageRequestSchema,
	ListBuildsQuerySchema,
	ValidateDockerfileRequestSchema,
} from '../schemas/image-schemas.js';
import { imageEventFromImage, sendImageEvent } from '../services/webhook-sender.js';
import {
	getAllTemplates,
	getTemplateById,
	getAllCategories,
	getTemplatesByCategory,
	renderTemplate,
} from '../services/dockerfile-templates.js';
import type { Image, ImageBuild } from '../types/index.js';

const buildsHandler: FastifyPluginAsync = async (fastify) => {
	// ---------------------------------------------------------------------
	// GET /api/v1/images/build/templates — List all Dockerfile templates
	// Query: ?category=Backend|Database|Web+Server|Microservices
	// ---------------------------------------------------------------------
	fastify.get('/api/v1/images/build/templates', { preHandler: fastify.authenticate }, async (req, reply) => {
		const category = (req.query as { category?: string }).category;

		if (category) {
			const templates = getTemplatesByCategory(category);
			return reply.send({
				category,
				templates,
			});
		}

		return reply.send({
			categories: getAllCategories(),
			templates: getAllTemplates(),
		});
	});

	// ---------------------------------------------------------------------
	// GET /api/v1/images/build/templates/:templateId — Get specific template
	// ---------------------------------------------------------------------
	fastify.get('/api/v1/images/build/templates/:templateId', { preHandler: fastify.authenticate }, async (req, reply) => {
		const { templateId } = req.params as { templateId: string };
		const template = getTemplateById(templateId);

		if (!template) {
			return reply.code(404).send({ error: 'template not found' });
		}

		return reply.send(template);
	});

	// ---------------------------------------------------------------------
	// POST /api/v1/images/build/validate — Validate Dockerfile
	// ---------------------------------------------------------------------
	fastify.post('/api/v1/images/build/validate', { preHandler: fastify.authenticate }, async (req, reply) => {
		const parsed = ValidateDockerfileRequestSchema.safeParse(req.body);
		if (!parsed.success) {
			return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
		}

		const { dockerfile } = parsed.data;
		const validation = imageManager.validateDockerfile(dockerfile);

		return reply.send(validation);
	});

	// ---------------------------------------------------------------------
	// POST /api/v1/images/build — Build image with Server-Sent Events stream
	//   Body: { dockerfile, repository, tag?, buildArgs?, description? }
	//   Streams Docker build progress as `data:` events, ends with `data: {"done":true,...}`.
	// ---------------------------------------------------------------------
	fastify.post('/api/v1/images/build', { preHandler: fastify.authenticate }, async (req, reply) => {
		const parsed = BuildImageRequestSchema.safeParse(req.body);
		if (!parsed.success) {
			return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
		}

		const { dockerfile, repository, tag, buildArgs, description } = parsed.data;
		const sub = req.clusterAuth?.sub ?? '__anonymous__';

		// First validate the Dockerfile
		const validation = imageManager.validateDockerfile(dockerfile);
		if (!validation.valid) {
			return reply.code(400).send({
				error: 'invalid_dockerfile',
				details: validation.errors,
				warnings: validation.warnings,
			});
		}

		// Create build record
		const buildId = crypto.randomUUID();
		const now = Date.now();
		const build: ImageBuild = {
			id: buildId,
			repository,
			tag,
			dockerfile,
			buildArgs,
			status: 'pending',
			errorMessage: null,
			imageId: null,
			startedAt: now,
			completedAt: null,
			createdBy: sub,
			buildLogs: null,
		};
		buildsRepo.insert(build);

		// Hijack the reply so we can write SSE frames directly
		reply.raw.setHeader('Content-Type', 'text/event-stream');
		reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
		reply.raw.setHeader('Connection', 'keep-alive');
		reply.raw.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
		reply.hijack();
		reply.raw.flushHeaders?.();

		const send = (data: unknown): void => {
			reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
		};

		// Accumulate build logs
		const logLines: string[] = [];

		try {
			// Update status to running
			buildsRepo.update(buildId, { status: 'running' });
			send({ buildId, status: 'running', message: 'Starting build...' });

			// Perform the build
			const inspected = await imageManager.build(
				dockerfile,
				repository,
				tag,
				buildArgs,
				(ev) => {
					// Stream build progress
					if (ev.stream) {
						logLines.push(ev.stream);
						send({ buildId, stream: ev.stream });
					} else if (ev.status) {
						send({ buildId, status: ev.status });
					} else if (ev.error) {
						logLines.push(`ERROR: ${ev.error}`);
						send({ buildId, error: ev.error });
					}
				},
			);

			// Build completed successfully
			const completedAt = Date.now();

			// Create image record
			const existing = imagesRepo.findByRepoTag(repository, tag);
			const image: Image = {
				id: existing?.id ?? crypto.randomUUID(),
				dockerImageId: inspected.dockerImageId,
				repository,
				tag,
				digest: inspected.digest,
				sizeBytes: inspected.sizeBytes,
				source: 'built',
				builtBy: sub,
				description: description ?? existing?.description ?? null,
				labels: {
					...inspected.labels,
					'privos.built-by': sub,
					'privos.build-id': buildId,
				},
				createdAt: existing?.createdAt ?? now,
				updatedAt: completedAt,
			};
			const saved = imagesRepo.upsertByRepoTag(image);

			// Update build record
			buildsRepo.update(buildId, {
				status: 'completed',
				imageId: saved.id,
				completedAt,
				buildLogs: logLines.join('\n'),
			});

			// Send webhook event
			sendImageEvent(imageEventFromImage(saved, 'image-built'));

			// Send final success event
			send({
				done: true,
				buildId,
				image: saved,
				build: {
					...build,
					status: 'completed',
					imageId: saved.id,
					completedAt,
					buildLogs: logLines.join('\n'),
				},
			});

		} catch (err: any) {
			const completedAt = Date.now();
			const errorMessage = err.message || 'Unknown build error';

			// Update build record as failed
			buildsRepo.update(buildId, {
				status: 'failed',
				errorMessage,
				completedAt,
				buildLogs: logLines.join('\n'),
			});

			fastify.log.error({ err, buildId, repository, tag }, 'build error');
			send({
				done: true,
				buildId,
				error: errorMessage,
				build: {
					...build,
					status: 'failed',
					errorMessage,
					completedAt,
					buildLogs: logLines.join('\n'),
				},
			});
		} finally {
			reply.raw.end();
		}
	});

	// ---------------------------------------------------------------------
	// GET /api/v1/images/builds — List build history
	//   Query: ?status=running|completed|failed&limit=20
	// ---------------------------------------------------------------------
	fastify.get('/api/v1/images/builds', { preHandler: fastify.authenticate }, async (req, reply) => {
		const parsed = ListBuildsQuerySchema.safeParse(req.query);
		if (!parsed.success) {
			return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
		}

		const { status, limit } = parsed.data;
		const filters: buildsRepo.ListBuildsFilters = { limit };

		if (status) {
			filters.status = status;
		}

		// If user is not admin, only show their own builds
		// For now, we'll filter by current user
		filters.createdBy = req.clusterAuth?.sub ?? '__none__';

		const builds = buildsRepo.findAll(filters);

		// Attach image details for completed builds
		const enriched = builds.map((build) => {
			let image = null;
			if (build.imageId) {
				image = imagesRepo.findById(build.imageId);
			}
			return { ...build, image };
		});

		return reply.send(enriched);
	});

	// ---------------------------------------------------------------------
	// GET /api/v1/images/builds/:buildId — Get build details
	// ---------------------------------------------------------------------
	fastify.get('/api/v1/images/builds/:buildId', { preHandler: fastify.authenticate }, async (req, reply) => {
		const params = BuildIdParamSchema.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ error: 'invalid buildId' });
		}

		const build = buildsRepo.findById(params.data.buildId);
		if (!build) {
			return reply.code(404).send({ error: 'build not found' });
		}

		// Check permission - only show own builds unless admin
		// For now, we'll allow viewing own builds
		if (build.createdBy !== req.clusterAuth?.sub) {
			return reply.code(403).send({ error: 'access denied' });
		}

		// Attach image details if available
		let image = null;
		if (build.imageId) {
			image = imagesRepo.findById(build.imageId);
		}

		return reply.send({ ...build, image });
	});

	// ---------------------------------------------------------------------
	// DELETE /api/v1/images/builds/:buildId — Delete build history
	// ---------------------------------------------------------------------
	fastify.delete('/api/v1/images/builds/:buildId', { preHandler: fastify.authenticate }, async (req, reply) => {
		const params = BuildIdParamSchema.safeParse(req.params);
		if (!params.success) {
			return reply.code(400).send({ error: 'invalid buildId' });
		}

		const build = buildsRepo.findById(params.data.buildId);
		if (!build) {
			return reply.code(404).send({ error: 'build not found' });
		}

		// Check permission - only delete own builds
		if (build.createdBy !== req.clusterAuth?.sub) {
			return reply.code(403).send({ error: 'access denied' });
		}

		buildsRepo.deleteById(params.data.buildId);
		return reply.code(204).send();
	});

	// ---------------------------------------------------------------------
	// GET /api/v1/images/builds/stats — Get build statistics for current user
	// ---------------------------------------------------------------------
	fastify.get('/api/v1/images/builds/stats', { preHandler: fastify.authenticate }, async (req, reply) => {
		const sub = req.clusterAuth?.sub;
		if (!sub) {
			return reply.code(401).send({ error: 'unauthorized' });
		}

		const stats = buildsRepo.getStatsForUser(sub);
		return reply.send(stats);
	});
};

export default fp(buildsHandler, { name: 'builds' });
