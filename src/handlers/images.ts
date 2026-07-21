/**
 * Image REST routes — read-only listing plus pull.
 * All routes require JWT auth via fastify.authenticate preHandler.
 *
 * The cluster deploys from existing images only (no build/registry-browse
 * UI) and keeps no image database — listing reads straight from the Docker
 * daemon on every request.
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { imageManager } from '../docker/index.js';
import { ListImagesQuerySchema, PullImageRequestSchema } from '../schemas/image-schemas.js';

const imagesHandler: FastifyPluginAsync = async (fastify) => {
    // ---------------------------------------------------------------------
    // GET /api/v1/images — list local Docker images
    //   ?q=<substring>  (matches repository or tag)
    // ---------------------------------------------------------------------
    fastify.get('/api/v1/images', { preHandler: fastify.authenticate }, async (req, reply) => {
        const parsed = ListImagesQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
        }
        const { q } = parsed.data;
        const images = await imageManager.list();
        const filtered = q
            ? images.filter(
                  (img) =>
                      img.repository.toLowerCase().includes(q.toLowerCase()) ||
                      img.tag.toLowerCase().includes(q.toLowerCase()),
              )
            : images;
        return reply.send(filtered);
    });

    // ---------------------------------------------------------------------
    // POST /api/v1/images/pull — Server-Sent Events stream
    //   Body: { repository, tag? }
    //   Streams Docker progress lines as `data:` events, ends with `data: {"done":true,...}`.
    // ---------------------------------------------------------------------
    fastify.post('/api/v1/images/pull', { preHandler: fastify.authenticate }, async (req, reply) => {
        const parsed = PullImageRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
        }
        const { repository, tag } = parsed.data;

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
            send({ done: true, image: inspected });
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
};

export default fp(imagesHandler, { name: 'images' });
