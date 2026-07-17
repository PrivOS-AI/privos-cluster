/**
 * Cluster settings routes — key/value store with typed validation.
 * All routes require JWT auth.
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import * as settingsRepo from '../db/settings-repo.js';
import * as settingsService from '../services/settings-service.js';
import {
    PatchSettingsBodySchema,
    PutSettingBodySchema,
    SettingKeyParamSchema,
    validateSettingValue,
} from '../schemas/settings-schemas.js';

const settingsHandler: FastifyPluginAsync = async (fastify) => {
    // GET /api/v1/settings — merged view: defaults + overrides
    fastify.get('/api/v1/settings', { preHandler: fastify.authenticate }, async (_req, reply) => {
        return reply.send(settingsService.getAllResolved());
    });

    // GET /api/v1/settings/:key — single setting (resolved with default fallback)
    fastify.get('/api/v1/settings/:key', { preHandler: fastify.authenticate }, async (req, reply) => {
        const params = SettingKeyParamSchema.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: 'invalid key' });
        const stored = settingsRepo.get(params.data.key);
        if (stored) return reply.send(stored);
        // Fallback to default if known
        if (settingsService.isKnownKey(params.data.key)) {
            return reply.send({
                key: params.data.key,
                value: settingsService.getValue(params.data.key as keyof settingsService.SettingsShape),
                updatedAt: null,
                updatedBy: null,
                isDefault: true,
            });
        }
        return reply.code(404).send({ error: 'setting not found' });
    });

    // PUT /api/v1/settings/:key — set a single setting (with per-key validation)
    fastify.put('/api/v1/settings/:key', { preHandler: fastify.authenticate }, async (req, reply) => {
        const params = SettingKeyParamSchema.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: 'invalid key' });
        const body = PutSettingBodySchema.safeParse(req.body);
        if (!body.success) {
            return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
        }
        const valid = validateSettingValue(params.data.key, body.data.value);
        if (!valid.success) {
            return reply.code(400).send({ error: 'invalid_value', details: valid.error.issues });
        }
        const saved = settingsRepo.set(params.data.key, valid.data, req.clusterAuth?.sub ?? null);
        return reply.send(saved);
    });

    // PATCH /api/v1/settings — bulk set { key: value, ... }; validates each entry
    fastify.patch('/api/v1/settings', { preHandler: fastify.authenticate }, async (req, reply) => {
        const body = PatchSettingsBodySchema.safeParse(req.body);
        if (!body.success) {
            return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
        }
        const errors: Array<{ key: string; issues: unknown }> = [];
        const validated: Array<[string, unknown]> = [];
        for (const [key, value] of Object.entries(body.data)) {
            const res = validateSettingValue(key, value);
            if (!res.success) errors.push({ key, issues: res.error.issues });
            else validated.push([key, res.data]);
        }
        if (errors.length > 0) {
            return reply.code(400).send({ error: 'invalid_values', errors });
        }
        const sub = req.clusterAuth?.sub ?? null;
        const saved = validated.map(([k, v]) => settingsRepo.set(k, v, sub));
        return reply.send({ updated: saved.length, settings: saved });
    });

    // DELETE /api/v1/settings/:key — revert to default
    fastify.delete('/api/v1/settings/:key', { preHandler: fastify.authenticate }, async (req, reply) => {
        const params = SettingKeyParamSchema.safeParse(req.params);
        if (!params.success) return reply.code(400).send({ error: 'invalid key' });
        const removed = settingsRepo.deleteByKey(params.data.key);
        return reply.code(removed ? 204 : 404).send();
    });
};

export default fp(settingsHandler, { name: 'settings' });
