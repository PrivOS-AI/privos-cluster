/**
 * WebSocket terminal handler.
 * GET /api/v1/apps/:containerId/terminal?token=<jwt>
 *
 * Auth via query param because browsers cannot send Authorization headers
 * on WebSocket upgrade. Token must be issued by 'privos-chat'.
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { verifyToken } from '../auth/jwt.js';
import * as dockerState from '../docker/docker-state.js';
import { containerManager } from '../docker/index.js';

const terminalHandler: FastifyPluginAsync = async (fastify) => {
    fastify.get(
        '/api/v1/apps/:containerId/terminal',
        { websocket: true },
        async (socket, req) => {
            const { containerId } = req.params as { containerId: string };
            const token = (req.query as Record<string, string>).token;

            // 1. Verify JWT — must be issued by privos-chat
            try {
                verifyToken(token, 'privos-chat');
            } catch {
                socket.send(JSON.stringify({ error: 'unauthorized' }));
                socket.close(4401, 'unauthorized');
                return;
            }

            // 2. Validate containerId format
            if (!containerId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(containerId)) {
                socket.close(4400, 'invalid_container_id');
                return;
            }

            // 3. Find container
            const container = await dockerState.getById(containerId);
            if (!container) {
                socket.close(4404, 'not_found');
                return;
            }
            if (container.state !== 'running') {
                socket.close(4400, 'not_running');
                return;
            }

            // 4. Create exec session
            let execStream: any;
            try {
                const exec = await containerManager.createExec(container.dockerContainerId);
                execStream = await exec.start({ hijack: true, stdin: true, Tty: true });

                // 5. Pipe exec output → WebSocket
                execStream.on('data', (chunk: Buffer) => {
                    if (socket.readyState === socket.OPEN) {
                        socket.send(chunk);
                    }
                });
                execStream.on('end', () => {
                    try { socket.close(1000); } catch {}
                });
                execStream.on('error', (err: Error) => {
                    fastify.log.error({ err, containerId }, 'exec stream error');
                    try { socket.close(1011, 'stream_error'); } catch {}
                });

                // 6. Pipe WebSocket messages → exec stdin
                socket.on('message', (data: Buffer | string) => {
                    const msg = data.toString();
                    // Check for resize JSON command
                    try {
                        const parsed = JSON.parse(msg);
                        if (
                            parsed.type === 'resize' &&
                            Number.isInteger(parsed.cols) &&
                            Number.isInteger(parsed.rows)
                        ) {
                            exec.resize({ h: parsed.rows, w: parsed.cols }).catch(() => {});
                            return;
                        }
                    } catch {
                        // Not JSON — raw terminal input
                    }
                    try {
                        execStream.write(data);
                    } catch (e) {
                        fastify.log.warn({ err: e, containerId }, 'failed to write to exec stream');
                    }
                });

                socket.on('close', () => {
                    try { execStream.end(); } catch {}
                });
                socket.on('error', (err: Error) => {
                    fastify.log.warn({ err, containerId }, 'websocket error');
                    try { execStream.end(); } catch {}
                });
            } catch (err: any) {
                fastify.log.error({ err, containerId }, 'failed to start exec');
                try { socket.close(1011, 'exec_failed'); } catch {}
            }
        },
    );
};

export default fp(terminalHandler, { name: 'terminal-handler' });
