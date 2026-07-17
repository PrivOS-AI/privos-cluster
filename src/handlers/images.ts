/**
 * Image management REST routes.
 * All routes require JWT auth via fastify.authenticate preHandler.
 *
 * Sources tracked:
 *   - pulled:     fetched from a registry via this API
 *   - built:      built via this API (TODO: build endpoint pending)
 *   - registered: image already present on the Docker host, surfaced by reconciliation
 */
import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import * as imagesRepo from '../db/images-repo.js';
import { imageManager } from '../docker/index.js';
import {
    DeleteImageQuerySchema,
    ImageIdParamSchema,
    ListImagesQuerySchema,
    PullImageRequestSchema,
    RegisterImageRequestSchema,
    TagImageRequestSchema,
    UpdateImageRequestSchema,
} from '../schemas/image-schemas.js';
import { imageEventFromImage, sendImageEvent } from '../services/webhook-sender.js';
import { getImageRegistryAllowlist } from '../services/settings-service.js';
import { deployManagedApp } from '../services/lifecycle-service.js';
import type { Image } from '../types/index.js';

/**
 * Best-effort hostname extraction for an image reference.
 * - "nginx" / "owner/repo" → "docker.io"
 * - "ghcr.io/owner/repo" / "registry.example.com:5000/foo" → leading segment
 */
function inferRegistryHost(repository: string): string {
    const first = repository.split('/')[0] ?? '';
    return first.includes('.') || first.includes(':') ? first : 'docker.io';
}

const imagesHandler: FastifyPluginAsync = async (fastify) => {
    // ---------------------------------------------------------------------
    // GET /api/v1/images — list with optional filters
    //   ?source=pulled|built|registered
    //   ?mine=true            (only images created by current JWT sub)
    //   ?q=<substring>        (matches repository or tag)
    // ---------------------------------------------------------------------
    fastify.get('/api/v1/images', { preHandler: fastify.authenticate }, async (req, reply) => {
        const parsed = ListImagesQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
        }
        const { source, mine, q } = parsed.data;
        const filters: imagesRepo.ListFilters = {};
        if (source) filters.source = source;
        if (q) filters.q = q;
        if (mine) filters.builtBy = req.clusterAuth?.sub ?? '__none__';
        return reply.send(imagesRepo.findAll(filters));
    });

    // ---------------------------------------------------------------------
    // GET /api/v1/images/:imageId
    // ---------------------------------------------------------------------
    fastify.get('/api/v1/images/:imageId', { preHandler: fastify.authenticate }, async (req, reply) => {
        const params = ImageIdParamSchema.safeParse(req.params);
        if (!params.success) {
            return reply.code(400).send({ error: 'invalid imageId' });
        }
        const img = imagesRepo.findById(params.data.imageId);
        if (!img) return reply.code(404).send({ error: 'image not found' });
        // Attach live Docker inspect so the UI can show layers/history without a second call.
        const live = await imageManager.inspect(`${img.repository}:${img.tag}`);
        const inUse = imagesRepo.countInUse(img.repository, img.tag);
        return reply.send({ ...img, live, inUse });
    });

    // ---------------------------------------------------------------------
    // POST /api/v1/images/pull — Server-Sent Events stream
    //   Body: { repository, tag?, description? }
    //   Streams Docker progress lines as `data:` events, ends with `data: {"done":true,...}`.
    // ---------------------------------------------------------------------
    fastify.post('/api/v1/images/pull', { preHandler: fastify.authenticate }, async (req, reply) => {
        const parsed = PullImageRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
        }
        const { repository, tag, description } = parsed.data;
        const sub = req.clusterAuth?.sub ?? null;

        // Enforce registry allowlist (empty = allow any).
        const allowlist = getImageRegistryAllowlist();
        if (allowlist.length > 0) {
            const host = inferRegistryHost(repository);
            if (!allowlist.includes(host)) {
                return reply.code(403).send({
                    error: 'registry_not_allowed',
                    host,
                    allowlist,
                    hint: 'add this hostname to images.registry_allowlist in /settings or clear the list to allow any',
                });
            }
        }

        // Hijack the reply so we can write SSE frames directly.
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
        reply.hijack();
        reply.raw.flushHeaders?.();

        const send = (data: unknown): void => {
            if (reply.raw.writableEnded) return;
            reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        // Detect client disconnect (browser fetch abort, tab close) and propagate
        // the cancellation down into imageManager.pull so it tears down the upstream
        // Docker pull stream.
        const controller = new AbortController();
        req.raw.once('close', () => {
            if (!reply.raw.writableEnded) controller.abort();
        });

        try {
            const inspected = await imageManager.pull(repository, tag, (ev) => send(ev), controller.signal);

            // Upsert DB row — mark as `pulled` and record current user as builtBy.
            const now = Date.now();
            const existing = imagesRepo.findByRepoTag(repository, tag);
            const row: Image = {
                id: existing?.id ?? crypto.randomUUID(),
                dockerImageId: inspected.dockerImageId,
                repository,
                tag,
                digest: inspected.digest,
                sizeBytes: inspected.sizeBytes,
                source: 'pulled',
                builtBy: existing?.builtBy ?? sub,
                description: description ?? existing?.description ?? null,
                labels: inspected.labels,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
            };
            const saved = imagesRepo.upsertByRepoTag(row);
            sendImageEvent(imageEventFromImage(saved, 'image-pulled'));
            send({ done: true, image: saved });
        } catch (err: any) {
            if (controller.signal.aborted) {
                fastify.log.info({ repository, tag }, 'pull cancelled by client');
                send({ cancelled: true, error: 'Pull cancelled' });
            } else {
                fastify.log.error({ err, repository, tag }, 'pull error');
                send({ error: err.message });
            }
        } finally {
            if (!reply.raw.writableEnded) reply.raw.end();
        }
    });

    // ---------------------------------------------------------------------
    // POST /api/v1/images/register — track an existing local image
    // Useful when the image was loaded via `docker load` or built outside the cluster.
    // ---------------------------------------------------------------------
    fastify.post('/api/v1/images/register', { preHandler: fastify.authenticate }, async (req, reply) => {
        const parsed = RegisterImageRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
        }
        const { repository, tag, description } = parsed.data;
        const sub = req.clusterAuth?.sub ?? null;

        const inspected = await imageManager.inspect(`${repository}:${tag}`);
        if (!inspected) {
            return reply
                .code(404)
                .send({ error: `image ${repository}:${tag} not found on the Docker host` });
        }
        const now = Date.now();
        const existing = imagesRepo.findByRepoTag(repository, tag);
        const row: Image = {
            id: existing?.id ?? crypto.randomUUID(),
            dockerImageId: inspected.dockerImageId,
            repository,
            tag,
            digest: inspected.digest,
            sizeBytes: inspected.sizeBytes,
            // Treat user-driven registration as "built" only if labels mark it so;
            // otherwise it's just an outside image surfaced into the cluster.
            source: inspected.labels?.['privos.built-by'] ? 'built' : 'registered',
            builtBy: existing?.builtBy ?? sub,
            description: description ?? existing?.description ?? null,
            labels: inspected.labels,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        const saved = imagesRepo.upsertByRepoTag(row);
        sendImageEvent(
            imageEventFromImage(saved, saved.source === 'built' ? 'image-built' : 'image-registered'),
        );
        return reply.code(201).send(saved);
    });

    // ---------------------------------------------------------------------
    // POST /api/v1/images/:imageId/tag — add another tag to an existing image
    // Creates a new DB row for the new repo:tag; the old row is preserved.
    // ---------------------------------------------------------------------
    fastify.post(
        '/api/v1/images/:imageId/tag',
        { preHandler: fastify.authenticate },
        async (req, reply) => {
            const params = ImageIdParamSchema.safeParse(req.params);
            if (!params.success) return reply.code(400).send({ error: 'invalid imageId' });
            const body = TagImageRequestSchema.safeParse(req.body);
            if (!body.success) {
                return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
            }
            const src = imagesRepo.findById(params.data.imageId);
            if (!src) return reply.code(404).send({ error: 'image not found' });

            try {
                await imageManager.tag(
                    `${src.repository}:${src.tag}`,
                    body.data.repository,
                    body.data.tag,
                );
            } catch (err: any) {
                fastify.log.error({ err }, 'tag error');
                return reply.code(500).send({ error: err.message });
            }

            const sub = req.clusterAuth?.sub ?? null;
            const now = Date.now();
            const newRow: Image = {
                id: crypto.randomUUID(),
                dockerImageId: src.dockerImageId,
                repository: body.data.repository,
                tag: body.data.tag,
                digest: src.digest,
                sizeBytes: src.sizeBytes,
                source: src.source,
                builtBy: src.builtBy ?? sub,
                description: src.description,
                labels: src.labels,
                createdAt: now,
                updatedAt: now,
            };
            const saved = imagesRepo.upsertByRepoTag(newRow);
            sendImageEvent(imageEventFromImage(saved, 'image-tagged'));
            return reply.code(201).send(saved);
        },
    );

    // ---------------------------------------------------------------------
    // PATCH /api/v1/images/:imageId — update description / labels (metadata only)
    // ---------------------------------------------------------------------
    fastify.patch(
        '/api/v1/images/:imageId',
        { preHandler: fastify.authenticate },
        async (req, reply) => {
            const params = ImageIdParamSchema.safeParse(req.params);
            if (!params.success) return reply.code(400).send({ error: 'invalid imageId' });
            const body = UpdateImageRequestSchema.safeParse(req.body);
            if (!body.success) {
                return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
            }
            const img = imagesRepo.findById(params.data.imageId);
            if (!img) return reply.code(404).send({ error: 'image not found' });

            imagesRepo.update(img.id, {
                description: body.data.description ?? img.description,
                labels: body.data.labels ?? img.labels,
            });
            return reply.send(imagesRepo.findById(img.id));
        },
    );

    // ---------------------------------------------------------------------
    // DELETE /api/v1/images/:imageId?force=true
    // Guards against deleting images currently referenced by managed containers
    // unless ?force=true is set.
    // ---------------------------------------------------------------------
    fastify.delete(
        '/api/v1/images/:imageId',
        { preHandler: fastify.authenticate },
        async (req, reply) => {
            const params = ImageIdParamSchema.safeParse(req.params);
            if (!params.success) return reply.code(400).send({ error: 'invalid imageId' });
            const query = DeleteImageQuerySchema.safeParse(req.query);
            if (!query.success) {
                return reply.code(400).send({ error: 'validation_error', details: query.error.issues });
            }
            const img = imagesRepo.findById(params.data.imageId);
            if (!img) return reply.code(404).send({ error: 'image not found' });

            const inUse = imagesRepo.countInUse(img.repository, img.tag);
            if (inUse > 0 && !query.data.force) {
                return reply.code(409).send({
                    error: 'image in use',
                    inUse,
                    hint: 'pass ?force=true to delete anyway (Docker will refuse if running)',
                });
            }
            try {
                await imageManager.remove(`${img.repository}:${img.tag}`, query.data.force);
            } catch (err: any) {
                fastify.log.error({ err }, 'remove image error');
                return reply.code(409).send({ error: err.message });
            }
            imagesRepo.deleteById(img.id);
            sendImageEvent(imageEventFromImage(img, 'image-removed'));
            return reply.code(204).send();
        },
    );

    // ---------------------------------------------------------------------
    // POST /api/v1/images/import — load images from a tarball (`docker save` output)
    // Multipart upload. Field name: "file". Optional field: "description".
    // Streams progress as SSE-style frames; ends with `data: {"done":true,...}`.
    // ---------------------------------------------------------------------
    fastify.post('/api/v1/images/import', { preHandler: fastify.authenticate }, async (req, reply) => {
        const data = await req.file();
        if (!data) {
            return reply.code(400).send({ error: 'no_file', hint: 'expected multipart field "file"' });
        }
        const filename = data.filename ?? 'image.tar';
        const description = (data.fields?.description as { value?: string } | undefined)?.value ?? null;
        const sub = req.clusterAuth?.sub ?? null;

        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Accel-Buffering', 'no');
        reply.hijack();
        reply.raw.flushHeaders?.();

        const send = (msg: unknown): void => {
            reply.raw.write(`data: ${JSON.stringify(msg)}\n\n`);
        };

        try {
            send({ status: 'uploading', filename });
            const loadedRepoTags = await imageManager.loadFromStream(data.file, (ev) => {
                if (ev.error) send({ error: ev.error });
                else if (ev.stream) send({ stream: ev.stream });
            });

            // Some tarballs contain multiple images; some are untagged. Inspect + persist each.
            const now = Date.now();
            const saved: Image[] = [];
            for (const repoTag of loadedRepoTags) {
                const inspected = await imageManager.inspect(repoTag);
                if (!inspected) continue;
                const existing = imagesRepo.findByRepoTag(inspected.repository, inspected.tag);
                const row: Image = {
                    id: existing?.id ?? crypto.randomUUID(),
                    dockerImageId: inspected.dockerImageId,
                    repository: inspected.repository,
                    tag: inspected.tag,
                    digest: inspected.digest,
                    sizeBytes: inspected.sizeBytes,
                    source: 'registered',
                    builtBy: existing?.builtBy ?? sub,
                    description: description ?? existing?.description ?? `Imported from ${filename}`,
                    labels: inspected.labels,
                    createdAt: existing?.createdAt ?? now,
                    updatedAt: now,
                };
                const persisted = imagesRepo.upsertByRepoTag(row);
                sendImageEvent(imageEventFromImage(persisted, 'image-registered'));
                saved.push(persisted);
            }

            send({ done: true, images: saved, count: saved.length });
        } catch (err: any) {
            fastify.log.error({ err, filename }, 'image import error');
            send({ error: err.message ?? String(err), done: true });
        } finally {
            reply.raw.end();
        }
    });

    // ---------------------------------------------------------------------
    // POST /api/v1/images/:imageId/run — one-click "Quick Run" from the library.
    // Body (all optional): { port?, subdomain?, appId? }
    //   - port: defaults to image's first EXPOSE'd TCP port, then 3001
    //   - subdomain: passed through to deploy
    //   - appId: passed through (metadata)
    // Resources use cluster defaults from settings.deploy.default_resources.
    // ---------------------------------------------------------------------
    fastify.post(
        '/api/v1/images/:imageId/run',
        { preHandler: fastify.authenticate },
        async (req, reply) => {
            const params = ImageIdParamSchema.safeParse(req.params);
            if (!params.success) return reply.code(400).send({ error: 'invalid imageId' });

            const img = imagesRepo.findById(params.data.imageId);
            if (!img) return reply.code(404).send({ error: 'image not found' });

            const body = (req.body ?? {}) as {
                port?: number;
                subdomain?: string | null;
                appId?: string;
            };

            let port = body.port;
            if (!port) {
                const detected = await imageManager.getExposedPort(`${img.repository}:${img.tag}`);
                port = detected ?? 3001;
            }

            try {
                const container = await deployManagedApp({
                    image: img.repository,
                    tag: img.tag,
                    port,
                    subdomain: body.subdomain ?? null,
                    appId: body.appId,
                    resources: {},
                    envVars: {},
                });
                return reply.code(201).send({
                    container,
                    detectedPort: port,
                });
            } catch (err: any) {
                fastify.log.error({ err, imageId: img.id }, 'quick run error');
                return reply.code(err.statusCode || 500).send({ error: err.message });
            }
        },
    );

    // ---------------------------------------------------------------------
    // POST /api/v1/images/prune — remove dangling images
    // ---------------------------------------------------------------------
    fastify.post('/api/v1/images/prune', { preHandler: fastify.authenticate }, async (_req, reply) => {
        try {
            const result = await imageManager.prune();
            return reply.send(result);
        } catch (err: any) {
            fastify.log.error({ err }, 'prune error');
            return reply.code(500).send({ error: err.message });
        }
    });
};

export default fp(imagesHandler, { name: 'images' });
