/**
 * Container filesystem endpoints.
 * GET /api/v1/apps/:containerId/files?path=/app        — list directory
 * GET /api/v1/apps/:containerId/files/content?path=... — read file content
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import path from 'node:path';
import * as dockerState from '../docker/docker-state.js';
import { containerManager } from '../docker/index.js';
import {
    ContainerIdParamSchema,
    FilesQuerySchema,
    FileContentQuerySchema,
} from '../schemas/app-schemas.js';

interface FileEntry {
    name: string;
    type: 'file' | 'directory' | 'link';
    size: number;
    modified: string;
}

/**
 * Resolve a caller path to an absolute POSIX path under /app, or null when it
 * falls outside. Normalising a rooted path first collapses every ".." segment,
 * so the prefix check below cannot be walked around.
 */
export function resolveContainerPath(raw: string | undefined): string | null {
    const p = path.posix.normalize('/' + (raw || '/app').trim());
    return p === '/app' || p.startsWith('/app/') ? p : null;
}

/** argv for the directory listing; run without a shell so the path is never interpreted. */
export function listDirectoryArgv(targetPath: string): string[] {
    return ['find', targetPath, '-maxdepth', '1', '-mindepth', '1', '-exec', 'stat', '-c', '%F|%s|%Y|%n', '{}', ';'];
}

const filesHandler: FastifyPluginAsync = async (fastify) => {
    // GET /api/v1/apps/:containerId/files?path=/app
    fastify.get('/api/v1/apps/:containerId/files', { preHandler: fastify.authenticate }, async (req, reply) => {
        try {
            const params = ContainerIdParamSchema.safeParse(req.params);
            if (!params.success) {
                return reply.code(400).send({ error: 'invalid containerId' });
            }

            const query = FilesQuerySchema.safeParse(req.query);
            if (!query.success) {
                return reply.code(400).send({ error: 'validation_error', details: query.error.issues });
            }

            const container = await dockerState.getById(params.data.containerId, undefined, req.clusterAuth?.workspaceId);
            if (!container) {
                return reply.code(404).send({ error: 'not found' });
            }
            if (container.state !== 'running') {
                return reply.code(409).send({ error: 'container not running' });
            }

            const targetPath = resolveContainerPath(query.data.path);
            if (!targetPath) {
                return reply.code(400).send({ error: 'path must be inside /app' });
            }

            const output = await containerManager.execCommand(container.dockerContainerId, listDirectoryArgv(targetPath));

            const entries: FileEntry[] = [];
            const lines = output.split('\n').filter((l) => l.trim());

            for (const line of lines) {
                const firstPipe = line.indexOf('|');
                if (firstPipe === -1) continue;
                const secondPipe = line.indexOf('|', firstPipe + 1);
                if (secondPipe === -1) continue;
                const thirdPipe = line.indexOf('|', secondPipe + 1);
                if (thirdPipe === -1) continue;

                const fileType = line.slice(0, firstPipe);
                const sizeStr = line.slice(firstPipe + 1, secondPipe);
                const mtimeStr = line.slice(secondPipe + 1, thirdPipe);
                const fullPath = line.slice(thirdPipe + 1);

                const name = fullPath.split('/').pop() || fullPath;
                if (!name) continue;

                const type: FileEntry['type'] = fileType.includes('directory')
                    ? 'directory'
                    : fileType.includes('link')
                    ? 'link'
                    : 'file';
                const size = parseInt(sizeStr, 10) || 0;
                const mtime = parseInt(mtimeStr, 10) || 0;
                const modified =
                    mtime > 0 ? new Date(mtime * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';

                entries.push({ name, type, size, modified });
            }

            // Directories first, then alphabetical
            entries.sort((a, b) => {
                if (a.type === 'directory' && b.type !== 'directory') return -1;
                if (a.type !== 'directory' && b.type === 'directory') return 1;
                return a.name.localeCompare(b.name);
            });

            return reply.send({ path: targetPath, entries });
        } catch (err: any) {
            fastify.log.error({ err }, 'files list error');
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    // GET /api/v1/apps/:containerId/files/content?path=/app/file.json
    fastify.get('/api/v1/apps/:containerId/files/content', { preHandler: fastify.authenticate }, async (req, reply) => {
        try {
            const params = ContainerIdParamSchema.safeParse(req.params);
            if (!params.success) {
                return reply.code(400).send({ error: 'invalid containerId' });
            }

            const query = FileContentQuerySchema.safeParse(req.query);
            if (!query.success) {
                return reply.code(400).send({ error: 'validation_error', details: query.error.issues });
            }

            const container = await dockerState.getById(params.data.containerId, undefined, req.clusterAuth?.workspaceId);
            if (!container) {
                return reply.code(404).send({ error: 'not found' });
            }
            if (container.state !== 'running') {
                return reply.code(409).send({ error: 'container not running' });
            }

            const safePath = resolveContainerPath(query.data.path);
            if (!safePath) {
                return reply.code(400).send({ error: 'path must be inside /app' });
            }

            // Check file size first — reject if >1MB
            const sizeOutput = await containerManager.execCommand(container.dockerContainerId, [
                'stat',
                '-c',
                '%s',
                safePath,
            ]);
            const fileSize = parseInt(sizeOutput.trim(), 10) || 0;
            if (fileSize > 1024 * 1024) {
                return reply.code(413).send({ error: 'file too large (max 1MB)' });
            }

            const content = await containerManager.execCommand(container.dockerContainerId, ['cat', safePath]);

            return reply.send({ path: safePath, content, size: fileSize });
        } catch (err: any) {
            fastify.log.error({ err }, 'file content error');
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });
};

export default fp(filesHandler, { name: 'files-handler' });
