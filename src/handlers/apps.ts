/**
 * App management REST routes.
 * All routes require JWT auth via fastify.authenticate preHandler.
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import * as dockerState from '../docker/docker-state.js';
import { containerManager, imageManager } from '../docker/index.js';
import { getHealth } from '../services/health-monitor.js';
import { checkResourceRequest } from '../services/resource-check.js';
import {
    getImageRegistryAllowlist,
    isReverseProxyEnabled,
    resolveDomain,
} from '../services/settings-service.js';
import {
    deployManagedApp,
    startContainer,
    stopContainer,
    restartContainer,
    redeployContainerSmart,
    deleteContainer,
} from '../services/lifecycle-service.js';
import {
    ContainerIdParamSchema,
    DeployRequestSchema,
    RedeployRequestSchema,
    DispatchBodySchema,
	McpDispatchBodySchema,
	McpDispatchBodyV3Schema,
} from '../schemas/app-schemas.js';
import { verifyAgentDispatchAssertion, verifyAgentDispatchAssertionV3 } from '../services/mcp-dispatch.js';
import { clusterMcpSafeReason, recordClusterMcpEvent } from '../services/mcp-observability.js';

interface ValidationCheck {
    id: string;
    label: string;
    status: 'ok' | 'warn' | 'fail';
    message?: string;
}

function inferRegistryHost(repository: string): string {
    const first = repository.split('/')[0] ?? '';
    return first.includes('.') || first.includes(':') ? first : 'docker.io';
}

function authorizedWorkspaceId(req: { clusterAuth?: { workspaceId?: string } }): string | undefined {
    return req.clusterAuth?.workspaceId;
}

function workspaceMatches(
    bodyWorkspaceId: string | undefined,
    authorizedWorkspace: string | undefined,
): boolean {
    return !config.FLEET_MODE || (
        Boolean(authorizedWorkspace) &&
        bodyWorkspaceId === authorizedWorkspace
    );
}

const appsHandler: FastifyPluginAsync = async (fastify) => {
    // POST /api/v1/apps/deploy/validate — dry-run preflight checks
    // Returns { ok, checks: [{ id, label, status, message? }] }
    // status: ok (pass) | warn (will still deploy but FYI) | fail (block)
    fastify.post('/api/v1/apps/deploy/validate', { preHandler: fastify.authenticate }, async (req, reply) => {
        const checks: ValidationCheck[] = [];

        // 1. Schema validation
        const parsed = DeployRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            const firstError = parsed.error.issues[0];
            const path = firstError?.path.join('.') || 'request';
            checks.push({
                id: 'schema',
                label: 'Request shape',
                status: 'fail',
                message: `${path}: ${firstError?.message ?? 'invalid'}`,
            });
            return reply.send({ ok: false, checks });
        }
        if (!workspaceMatches(parsed.data.workspaceId, authorizedWorkspaceId(req))) {
            return reply.code(403).send({ error: 'workspace_scope_mismatch' });
        }
        checks.push({ id: 'schema', label: 'Request shape', status: 'ok' });

        const { image, tag, port, resources, subdomain, domain, envVars, volumes } = parsed.data;

        // 2. Image identifier looks plausible
        if (!image.trim()) {
            checks.push({ id: 'image', label: 'Image identifier', status: 'fail', message: 'image is required' });
        } else if (image.endsWith('/') || image.startsWith('/')) {
            checks.push({ id: 'image', label: 'Image identifier', status: 'fail', message: 'invalid leading/trailing slash' });
        } else {
            checks.push({ id: 'image', label: 'Image identifier', status: 'ok', message: `${image}:${tag}` });
        }

        // 3. Registry allowlist (empty = allow any)
        const allowlist = getImageRegistryAllowlist();
        if (allowlist.length > 0) {
            const host = inferRegistryHost(image);
            if (!allowlist.includes(host)) {
                checks.push({
                    id: 'registry',
                    label: 'Registry allowlist',
                    status: 'fail',
                    message: `${host} is not in allowlist (${allowlist.join(', ')})`,
                });
            } else {
                checks.push({ id: 'registry', label: 'Registry allowlist', status: 'ok', message: `${host} is allowed` });
            }
        } else {
            checks.push({ id: 'registry', label: 'Registry allowlist', status: 'ok', message: 'any registry allowed' });
        }

        // 4. Image availability — check the Docker host directly (no image DB).
        let imageOnHost = false;
        try {
            const inspected = await imageManager.inspect(`${image}:${tag}`);
            imageOnHost = inspected !== null;
        } catch {
            imageOnHost = false;
        }
        if (imageOnHost) {
            checks.push({ id: 'image-available', label: 'Image availability', status: 'ok', message: 'present locally' });
        } else {
            checks.push({
                id: 'image-available',
                label: 'Image availability',
                status: 'warn',
                message: 'not local, cluster will pull on deploy',
            });
        }

        // 5. Port range
        if (port < 1 || port > 65535) {
            checks.push({ id: 'port', label: 'Port', status: 'fail', message: 'port must be 1-65535' });
        } else {
            checks.push({ id: 'port', label: 'Port', status: 'ok', message: String(port) });
        }

        // 6. Resource budget
        const mem = resources.memoryMb ?? 256;
        const cpus = resources.cpus ?? 0.5;
        try {
            const r = await checkResourceRequest({ memoryMb: mem, cpus });
            if (r.ok) {
                checks.push({
                    id: 'resources',
                    label: 'Resource budget',
                    status: 'ok',
                    message: `${mem} MB · ${cpus} CPU fits in available ${r.available.memoryMb} MB / ${r.available.cpus.toFixed(2)} CPU`,
                });
            } else {
                checks.push({
                    id: 'resources',
                    label: 'Resource budget',
                    status: 'fail',
                    message: `not enough ${r.reason}: requested ${mem} MB / ${cpus} CPU, available ${r.available.memoryMb} MB / ${r.available.cpus.toFixed(2)} CPU`,
                });
            }
        } catch (err: any) {
            checks.push({ id: 'resources', label: 'Resource budget', status: 'warn', message: err.message });
        }

        // 7. Subdomain availability
        if (subdomain) {
            const resolvedDomain = resolveDomain(domain);
            const existing = await dockerState.findByHost(subdomain, resolvedDomain);
            if (existing) {
                checks.push({
                    id: 'subdomain',
                    label: 'Host availability',
                    status: 'fail',
                    message: `${resolvedDomain ? `${subdomain}.${resolvedDomain}` : subdomain} taken by container ${existing.id}`,
                });
            } else if (!isReverseProxyEnabled()) {
                checks.push({
                    id: 'subdomain',
                    label: 'Host availability',
                    status: 'warn',
                    message: 'subdomain stored but reverse proxy is disabled (set REVERSE_PROXY_ENABLED / PRIVOS_DOMAINS)',
                });
            } else if (domain && !resolvedDomain) {
                checks.push({
                    id: 'subdomain',
                    label: 'Host availability',
                    status: 'fail',
                    message: `domain "${domain}" is not in the configured domain list`,
                });
            } else if (!resolvedDomain) {
                checks.push({
                    id: 'subdomain',
                    label: 'Host availability',
                    status: 'warn',
                    message: 'reverse proxy is on but no base domain is configured',
                });
            } else {
                checks.push({
                    id: 'subdomain',
                    label: 'Host availability',
                    status: 'ok',
                    message: `${subdomain}.${resolvedDomain} available`,
                });
            }
        }

        // 8. Env vars sanity (DeployRequestSchema already parsed it as Record<string,string>)
        const envCount = Object.keys(envVars ?? {}).length;
        checks.push({
            id: 'env',
            label: 'Environment variables',
            status: 'ok',
            message: envCount === 0 ? 'no overrides' : `${envCount} variable${envCount === 1 ? '' : 's'}`,
        });

        // 9. Volumes
        const volCount = (volumes ?? []).length;
        if (volCount > 0) {
            checks.push({
                id: 'volumes',
                label: 'Volumes',
                status: 'ok',
                message: `${volCount} volume${volCount === 1 ? '' : 's'} will be mounted`,
            });
        }

        const ok = !checks.some((c) => c.status === 'fail');
        return reply.send({ ok, checks });
    });

    // POST /api/v1/apps/deploy
    fastify.post('/api/v1/apps/deploy', { preHandler: fastify.authenticate }, async (req, reply) => {
        try {
            const parsed = DeployRequestSchema.safeParse(req.body);
            if (!parsed.success) {
                return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
            }
            const workspaceId = authorizedWorkspaceId(req);
            if (!workspaceMatches(parsed.data.workspaceId, workspaceId)) {
                return reply.code(403).send({ error: 'workspace_scope_mismatch' });
            }
            const container = await deployManagedApp(parsed.data);
            return reply.code(201).send(container);
        } catch (err: any) {
            fastify.log.error({ err }, 'deploy error');
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    // GET /api/v1/apps
    fastify.get('/api/v1/apps', { preHandler: fastify.authenticate }, async (req, reply) => {
        try {
            const containers = await dockerState.listManaged(getHealth, authorizedWorkspaceId(req));
            return reply.send(containers);
        } catch (err: any) {
            fastify.log.error({ err }, 'list apps error');
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    // GET /api/v1/apps/:containerId
    fastify.get('/api/v1/apps/:containerId', { preHandler: fastify.authenticate }, async (req, reply) => {
        try {
            const params = ContainerIdParamSchema.safeParse(req.params);
            if (!params.success) {
                return reply.code(400).send({ error: 'invalid containerId' });
            }
            const container = await dockerState.getById(
                params.data.containerId,
                getHealth,
                authorizedWorkspaceId(req),
            );
            if (!container) {
                return reply.code(404).send({ error: 'not found' });
            }
            return reply.send(container);
        } catch (err: any) {
            fastify.log.error({ err }, 'get app error');
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    // POST /api/v1/apps/:containerId/start
    fastify.post('/api/v1/apps/:containerId/start', { preHandler: fastify.authenticate }, async (req, reply) => {
        try {
            const params = ContainerIdParamSchema.safeParse(req.params);
            if (!params.success) {
                return reply.code(400).send({ error: 'invalid containerId' });
            }
            const container = await startContainer(params.data.containerId, authorizedWorkspaceId(req));
            return reply.send(container);
        } catch (err: any) {
            fastify.log.error({ err }, 'start container error');
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    // POST /api/v1/apps/:containerId/stop
    fastify.post('/api/v1/apps/:containerId/stop', { preHandler: fastify.authenticate }, async (req, reply) => {
        try {
            const params = ContainerIdParamSchema.safeParse(req.params);
            if (!params.success) {
                return reply.code(400).send({ error: 'invalid containerId' });
            }
            const container = await stopContainer(params.data.containerId, authorizedWorkspaceId(req));
            return reply.send(container);
        } catch (err: any) {
            fastify.log.error({ err }, 'stop container error');
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    // POST /api/v1/apps/:containerId/restart
    fastify.post('/api/v1/apps/:containerId/restart', { preHandler: fastify.authenticate }, async (req, reply) => {
        try {
            const params = ContainerIdParamSchema.safeParse(req.params);
            if (!params.success) {
                return reply.code(400).send({ error: 'invalid containerId' });
            }
            const container = await restartContainer(params.data.containerId, authorizedWorkspaceId(req));
            return reply.send(container);
        } catch (err: any) {
            fastify.log.error({ err }, 'restart container error');
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    // POST /api/v1/apps/:containerId/redeploy
    fastify.post('/api/v1/apps/:containerId/redeploy', { preHandler: fastify.authenticate }, async (req, reply) => {
        try {
            const params = ContainerIdParamSchema.safeParse(req.params);
            if (!params.success) {
                return reply.code(400).send({ error: 'invalid containerId' });
            }
            const body = RedeployRequestSchema.safeParse(req.body);
            if (!body.success) {
                return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
            }
            const workspaceId = authorizedWorkspaceId(req);
            if (!workspaceMatches(body.data.workspaceId, workspaceId)) {
                return reply.code(403).send({ error: 'workspace_scope_mismatch' });
            }
            const container = await redeployContainerSmart(
                params.data.containerId,
                body.data,
                workspaceId,
            );
            return reply.send(container);
        } catch (err: any) {
            fastify.log.error({ err }, 'redeploy error');
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    // DELETE /api/v1/apps/:containerId
    // Labels are immutable, so delete always stops + removes the Docker container
    // and its volumes — there is no "detach" (unmanage-only) option anymore.
    fastify.delete('/api/v1/apps/:containerId', { preHandler: fastify.authenticate }, async (req, reply) => {
        try {
            const params = ContainerIdParamSchema.safeParse(req.params);
            if (!params.success) {
                return reply.code(400).send({ error: 'invalid containerId' });
            }
            await deleteContainer(params.data.containerId, authorizedWorkspaceId(req));
            return reply.send({ ok: true });
        } catch (err: any) {
            fastify.log.error({ err }, 'delete container error');
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    // GET /api/v1/apps/:containerId/status
    fastify.get('/api/v1/apps/:containerId/status', { preHandler: fastify.authenticate }, async (req, reply) => {
        try {
            const params = ContainerIdParamSchema.safeParse(req.params);
            if (!params.success) {
                return reply.code(400).send({ error: 'invalid containerId' });
            }
            const container = await dockerState.getById(
                params.data.containerId,
                getHealth,
                authorizedWorkspaceId(req),
            );
            if (!container) {
                return reply.code(404).send({ error: 'not found' });
            }

            let stats: { cpuPercent: number; memoryUsageMb: number; memoryLimitMb: number; memoryPercent: number } | null = null;
            let uptime: number | null = null;

            if (container.state === 'running') {
                try {
                    stats = await containerManager.getContainerStats(container.dockerContainerId);
                } catch (e) {
                    fastify.log.warn({ err: e, containerId: container.id }, 'failed to get container stats');
                }
                try {
                    const info = await containerManager.inspectContainer(container.dockerContainerId);
                    if (info.State?.StartedAt) {
                        const startedAt = new Date(info.State.StartedAt).getTime();
                        uptime = Math.floor((Date.now() - startedAt) / 1000);
                    }
                } catch (e) {
                    fastify.log.warn({ err: e, containerId: container.id }, 'failed to inspect container');
                }
            }

            const status = {
                state: container.state,
                cpuPercent: stats?.cpuPercent ?? 0,
                memoryUsageMb: stats?.memoryUsageMb ?? 0,
                memoryLimitMb: stats?.memoryLimitMb ?? container.resources.memoryMb,
                memoryPercent: stats?.memoryPercent ?? 0,
                uptime,
                restarts: container.healthCheck.restartCount,
                healthStatus: container.healthCheck.status,
            };

            return reply.send(status);
        } catch (err: any) {
            fastify.log.error({ err }, 'status error');
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });

    // POST /api/v1/apps/:containerId/dispatch
    fastify.post('/api/v1/apps/:containerId/dispatch', { preHandler: fastify.authenticate }, async (req, reply) => {
        try {
            const params = ContainerIdParamSchema.safeParse(req.params);
            if (!params.success) {
                return reply.code(400).send({ error: 'invalid containerId' });
            }
            const container = await dockerState.getById(
                params.data.containerId,
                undefined,
                authorizedWorkspaceId(req),
            );
            if (!container) {
                return reply.code(404).send({ error: 'not found' });
            }
            if (container.state !== 'running') {
                return reply.code(409).send({ error: 'container not running' });
            }
			const info = await containerManager.inspectContainer(container.dockerContainerId);
			const labels = (info.Config?.Labels ?? {}) as Record<string, string>;
			let rpc: unknown;
			let dispatchAssertion: string | undefined;
			if (labels['privos.mcp.schema'] === '3') {
				if (config.APP_CLUSTER_MCP_INSTALL_V3 !== 'on') {
					return reply.code(403).send({ error: 'mcp_dispatch_denied', code: 'mcp_install_v3_disabled' });
				}
				const body = McpDispatchBodyV3Schema.safeParse(req.body);
				if (!body.success) return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
				try {
					verifyAgentDispatchAssertionV3({
						compact: body.data.assertion,
						rpc: body.data.rpc,
						labels,
						authorization: body.data,
					});
				} catch (error) {
					const reason = clusterMcpSafeReason(error, 'dispatch_assertion_invalid');
					recordClusterMcpEvent({ event: 'private_dispatch', outcome: 'denied', boundary: 'agent_v3', reason, correlationId: labels['privos.mcp.runtime-installation'] });
					return reply.code(403).send({ error: 'mcp_dispatch_denied', code: reason });
				}
				rpc = body.data.rpc;
				dispatchAssertion = body.data.assertion;
			} else if (labels['privos.mcp.schema'] === '2') {
				const body = McpDispatchBodySchema.safeParse(req.body);
				if (!body.success) return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
				try {
					verifyAgentDispatchAssertion({ compact: body.data.assertion, rpc: body.data.rpc, labels });
				} catch (error) {
					const reason = clusterMcpSafeReason(error, 'dispatch_assertion_invalid');
					recordClusterMcpEvent({ event: 'private_dispatch', outcome: 'denied', boundary: 'agent', reason, correlationId: labels['privos.mcp.installation'] });
					return reply.code(403).send({ error: 'mcp_dispatch_denied', code: reason });
				}
				recordClusterMcpEvent({ event: 'private_dispatch', outcome: 'allowed', boundary: 'agent', reason: 'verified', correlationId: labels['privos.mcp.installation'], emitLog: false });
				rpc = body.data.rpc;
				dispatchAssertion = body.data.assertion;
			} else {
				const body = DispatchBodySchema.safeParse(req.body);
				if (!body.success) return reply.code(400).send({ error: 'validation_error', details: body.error.issues });
				rpc = body.data;
			}

            const upstream = await fetch(`${container.internalUrl}/mcp`, {
                method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(dispatchAssertion ? { 'x-privos-dispatch-assertion': dispatchAssertion } : {}),
				},
				body: JSON.stringify(rpc),
                signal: AbortSignal.timeout(30_000),
            });

            reply.code(upstream.status);
            return upstream.json();
        } catch (err: any) {
            fastify.log.error({ err }, 'dispatch error');
            if (err.name === 'TimeoutError') {
                return reply.code(504).send({ error: 'upstream timeout' });
            }
            return reply.code(err.statusCode || 500).send({ error: err.message });
        }
    });
};

export default fp(appsHandler, { name: 'apps-handler' });
