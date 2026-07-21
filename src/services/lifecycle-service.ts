import crypto from 'crypto';
import pino from 'pino';
import { config } from '../config.js';
import { containerManager, networkManager } from '../docker/index.js';
import * as containersRepo from '../db/containers-repo.js';
import * as volumesRepo from '../db/volumes-repo.js';
import { checkResourceRequest } from './resource-check.js';
import { getDefaultResources, isReverseProxyEnabled, resolveDomain } from './settings-service.js';
import { eventFromContainer, sendEvent } from './webhook-sender.js';
import type { Container, ContainerResources, ContainerVolume, ContainerVolumeRow, DeployRequest, RedeployRequest } from '../types/index.js';

const logger = pino({ level: config.LOG_LEVEL }).child({ component: 'lifecycle' });

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TAG = 'latest';
const DEFAULT_PORT = 3001;

/**
 * Build a human-friendly Docker container name.
 *
 *   priority for the "base" segment:
 *     appId  (if user supplied)  →  subdomain  →  last segment of image path
 *
 *   format: <sanitized-base>-<6 hex chars from a fresh UUID>
 *   sanitize: lowercase, strip non-[a-z0-9-], collapse repeated dashes, trim length 30
 *
 * Examples:
 *   { appId: 'my-blog' }                 → 'my-blog-7f3a9b'
 *   { subdomain: 'todo' }                → 'todo-7f3a9b'
 *   { image: 'nginx' }                   → 'nginx-7f3a9b'
 *   { image: 'ghcr.io/me/todo-app' }     → 'todo-app-7f3a9b'
 *   { image: 'bitnami/postgres' }        → 'postgres-7f3a9b'
 */
export function buildContainerName(opts: {
    appId?: string | null;
    subdomain?: string | null;
    image: string;
}): string {
    let base = '';
    if (opts.appId && opts.appId.trim()) {
        base = opts.appId.trim();
    } else if (opts.subdomain && opts.subdomain.trim()) {
        base = opts.subdomain.trim();
    } else {
        const segments = opts.image.split('/').filter(Boolean);
        base = segments[segments.length - 1] ?? 'app';
        // image ref may include ":tag" — strip it
        const colon = base.indexOf(':');
        if (colon > 0) base = base.slice(0, colon);
    }

    const safe = base
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 30) || 'app';

    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 6);
    return `${safe}-${suffix}`;
}
const DEFAULT_RESOURCES: ContainerResources = {
    memoryMb: 256,
    cpus: 0.5,
    tmpSizeMb: 64,
};

// ---------------------------------------------------------------------------
// waitForHealthy
// ---------------------------------------------------------------------------

/**
 * Poll /health every 1s up to timeoutMs.
 * Falls back to /.well-known/mcp/manifest.json on 404.
 * Returns true if healthy, false on timeout (lifecycle still proceeds).
 */
async function waitForHealthy(internalUrl: string, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let use404Fallback = false;

    while (Date.now() < deadline) {
        try {
            const endpoint = use404Fallback
                ? `${internalUrl}/.well-known/mcp/manifest.json`
                : `${internalUrl}/health`;
            const res = await fetch(endpoint, { signal: AbortSignal.timeout(2_000) });
            if (res.ok) return true;
            if (!use404Fallback && res.status === 404) {
                use404Fallback = true; // try manifest on next iteration
            }
        } catch {
            // network/timeout — keep polling
        }
        await new Promise<void>((r) => setTimeout(r, 1_000));
    }
    return false;
}

// ---------------------------------------------------------------------------
// getHostPortWithRetry — host port assignment can lag start by a few ms
// ---------------------------------------------------------------------------

async function getHostPortWithRetry(
    dockerContainerId: string,
    port: number,
    maxAttempts = 3,
): Promise<number> {
    let lastErr: Error | undefined;
    for (let i = 0; i < maxAttempts; i++) {
        try {
            return await containerManager.getHostPort(dockerContainerId, port);
        } catch (err: any) {
            lastErr = err;
            if (i < maxAttempts - 1) {
                await new Promise<void>((r) => setTimeout(r, 100));
            }
        }
    }
    throw lastErr;
}

// ---------------------------------------------------------------------------
// Helper — load container or throw
// ---------------------------------------------------------------------------

function requireContainer(containerId: string): Container {
    const c = containersRepo.findById(containerId);
    if (!c) throw new Error(`Container not found: ${containerId}`);
    return c;
}

/**
 * Throws a 409-style Error if the full host (subdomain + domain) is already
 * taken by a different container. Uniqueness is per host, so the same subdomain
 * label can be reused under a different domain.
 */
function assertHostAvailable(
    subdomain: string | null | undefined,
    domain: string | null,
    ignoreContainerId?: string,
): void {
    if (!subdomain) return;
    const existing = containersRepo.findByHost(subdomain, domain);
    if (existing && existing.id !== ignoreContainerId) {
        const host = domain ? `${subdomain}.${domain}` : subdomain;
        const err: Error & { statusCode?: number } = new Error(
            `Host "${host}" is already in use by container ${existing.id}`,
        );
        err.statusCode = 409;
        throw err;
    }
}

/**
 * Throws a 409-style Error if the requested resources would exceed the cluster
 * budget. Skips the check when ignoreContainerId is provided AND that container's
 * existing allocation already covers the new request (rolling redeploys, etc.).
 */
async function assertResourceBudget(
    resources: ContainerResources,
    ignoreContainerId?: string,
): Promise<void> {
    let req = resources;
    if (ignoreContainerId) {
        const existing = containersRepo.findById(ignoreContainerId);
        if (existing) {
            req = {
                memoryMb: Math.max(0, resources.memoryMb - existing.resources.memoryMb),
                cpus: Math.max(0, resources.cpus - existing.resources.cpus),
                tmpSizeMb: resources.tmpSizeMb,
            };
        }
    }
    const check = await checkResourceRequest({ memoryMb: req.memoryMb, cpus: req.cpus });
    if (!check.ok) {
        const field = check.reason === 'memory' ? 'memoryMb' : 'cpus';
        const err: Error & { statusCode?: number; details?: unknown } = new Error(
            `Not enough ${check.reason} available (requested ${check.requested[field]}, available ${check.available[field]})`,
        );
        err.statusCode = 409;
        err.details = check;
        throw err;
    }
}

// ---------------------------------------------------------------------------
// deployManagedApp
// ---------------------------------------------------------------------------

export async function deployManagedApp(req: DeployRequest): Promise<Container> {
    await networkManager.ensureNetwork();

    // Cluster always generates its own UUID for container naming (uniqueness).
    // req.appId is stored as metadata only.
    const clusterId = crypto.randomUUID();
    const shortId = clusterId.slice(0, 12);
    const image = req.image;
    const tag = req.tag ?? DEFAULT_TAG;
    const port = req.port ?? DEFAULT_PORT;
    const resources: ContainerResources = {
        ...getDefaultResources(), // user-configurable in /settings
        ...req.resources,
    };
    const envVars = req.envVars ?? {};
    const volumeSpecs: ContainerVolume[] = req.volumes ?? [];
    const subdomain = req.subdomain ?? null;
    // Resolve which base domain to publish under (validated against the configured list).
    const baseDomain = isReverseProxyEnabled() ? resolveDomain(req.domain) : null;

    logger.info(
        { clusterId, image, tag, port, volumeCount: volumeSpecs.length, subdomain, baseDomain },
        'deploying managed app',
    );

    assertHostAvailable(subdomain, baseDomain);
    await assertResourceBudget(resources);

    await containerManager.pullImage(image, tag);

    let dockerContainerId: string | null = null;
    let dockerContainerName: string | null = null;
    const createdDockerVolumes: string[] = [];

    try {
        // Create Docker named volumes for each requested volume
        const volumeRows: ContainerVolumeRow[] = [];
        for (const vol of volumeSpecs) {
            const dockerVolumeName = `mcp-vol-${shortId}-${vol.name}`;
            await containerManager.ensureVolume(dockerVolumeName, vol.sizeMb);
            createdDockerVolumes.push(dockerVolumeName);
            volumeRows.push({
                id: crypto.randomUUID(),
                containerId: clusterId,
                name: vol.name,
                dockerVolumeName,
                mountPath: vol.mountPath,
                sizeMb: vol.sizeMb,
                createdAt: Date.now(),
            });
        }

        const mounts = volumeRows.map((v) => ({
            dockerVolumeName: v.dockerVolumeName,
            mountPath: v.mountPath,
        }));

        const containerName = buildContainerName({
            appId: req.appId,
            subdomain,
            image,
        });
        const createdAt = Date.now();
        const created = await containerManager.createAppContainer({
            id: clusterId,
            appId: req.appId ?? shortId,
            containerName,
            image,
            tag,
            port,
            resources,
            envVars,
            mounts,
            subdomain,
            baseDomain,
            createdAt,
        });
        dockerContainerId = created.containerId;
        dockerContainerName = created.containerName;

        await containerManager.startContainer(dockerContainerId);

        const hostPort = await getHostPortWithRetry(dockerContainerId, port);
        const internalUrl = `http://localhost:${hostPort}`;

        const healthy = await waitForHealthy(internalUrl, 30_000);
        if (!healthy) {
            logger.warn({ clusterId, internalUrl }, 'container did not become healthy within 30s — proceeding anyway');
        }

        const now = Date.now();
        const container: Container = {
            id: clusterId,
            appId: req.appId ?? null,
            dockerContainerId,
            dockerContainerName,
            image,
            tag,
            state: 'running',
            internalUrl,
            port,
            hostPort,
            resources,
            envVars,
            healthCheck: {
                status: healthy ? 'healthy' : 'unknown',
                failCount: 0,
                restartCount: 0,
                lastCheck: now,
            },
            createdAt,
            startedAt: now,
            stoppedAt: null,
            volumes: volumeRows.map((v) => ({ name: v.name, mountPath: v.mountPath, sizeMb: v.sizeMb })),
            subdomain,
            domain: baseDomain,
        };

        containersRepo.insert(container);
        // Persist volume rows after container is inserted (FK constraint)
        for (const vr of volumeRows) {
            volumesRepo.insert(vr);
        }
        sendEvent(eventFromContainer(container, 'deployed'));
        logger.info({ clusterId, dockerContainerId, internalUrl }, 'deploy complete');
        return container;
    } catch (err: any) {
        logger.error({ clusterId, dockerContainerId, err: err.message }, 'deploy failed — rolling back');
        if (dockerContainerId) {
            try {
                await containerManager.stopContainer(dockerContainerId, 5);
            } catch {
                // best-effort
            }
            try {
                await containerManager.removeContainer(dockerContainerId, true);
            } catch {
                // best-effort
            }
        }
        // Roll back created Docker volumes
        for (const volName of createdDockerVolumes) {
            try {
                await containerManager.removeVolume(volName);
            } catch {
                // best-effort
            }
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// startContainer
// ---------------------------------------------------------------------------

export async function startContainer(containerId: string): Promise<Container> {
    const c = requireContainer(containerId);

    logger.info({ containerId, dockerContainerId: c.dockerContainerId }, 'starting container');

    await containerManager.startContainer(c.dockerContainerId);

    // Port mapping changes after stop/start
    const hostPort = await getHostPortWithRetry(c.dockerContainerId, c.port);
    const internalUrl = `http://localhost:${hostPort}`;

    const healthy = await waitForHealthy(internalUrl, 30_000);
    if (!healthy) {
        logger.warn({ containerId, internalUrl }, 'container did not become healthy within 30s');
    }

    const now = Date.now();
    containersRepo.updateState(containerId, 'running', {
        startedAt: now,
        internalUrl,
        hostPort,
    });

    const updated: Container = {
        ...c,
        state: 'running',
        internalUrl,
        hostPort,
        startedAt: now,
        healthCheck: {
            ...c.healthCheck,
            status: healthy ? 'healthy' : 'unknown',
            lastCheck: now,
        },
    };

    sendEvent(eventFromContainer(updated, 'started'));
    return updated;
}

// ---------------------------------------------------------------------------
// stopContainer
// ---------------------------------------------------------------------------

export async function stopContainer(containerId: string): Promise<Container> {
    const c = requireContainer(containerId);

    logger.info({ containerId, dockerContainerId: c.dockerContainerId }, 'stopping container');

    await containerManager.stopContainer(c.dockerContainerId, 10);

    const now = Date.now();
    containersRepo.updateState(containerId, 'stopped', { stoppedAt: now });

    const updated: Container = {
        ...c,
        state: 'stopped',
        stoppedAt: now,
    };

    sendEvent(eventFromContainer(updated, 'stopped'));
    return updated;
}

// ---------------------------------------------------------------------------
// restartContainer
// ---------------------------------------------------------------------------

export async function restartContainer(containerId: string): Promise<Container> {
    const c = requireContainer(containerId);

    logger.info({ containerId, dockerContainerId: c.dockerContainerId }, 'restarting container');

    await containerManager.restartContainer(c.dockerContainerId);

    // Port mapping may change after restart
    const hostPort = await getHostPortWithRetry(c.dockerContainerId, c.port);
    const internalUrl = `http://localhost:${hostPort}`;

    const healthy = await waitForHealthy(internalUrl, 30_000);
    if (!healthy) {
        logger.warn({ containerId, internalUrl }, 'container did not become healthy within 30s after restart');
    }

    const now = Date.now();
    containersRepo.updateState(containerId, 'running', {
        startedAt: now,
        internalUrl,
        hostPort,
    });

    const updated: Container = {
        ...c,
        state: 'running',
        internalUrl,
        hostPort,
        startedAt: now,
        healthCheck: {
            ...c.healthCheck,
            status: healthy ? 'healthy' : 'unknown',
            lastCheck: now,
        },
    };

    sendEvent(eventFromContainer(updated, 'restarted'));
    return updated;
}

// ---------------------------------------------------------------------------
// redeployContainer
// ---------------------------------------------------------------------------

export async function redeployContainer(containerId: string, req: RedeployRequest): Promise<Container> {
    const c = requireContainer(containerId);
    if (c.adopted) {
        throw new Error('Cannot redeploy adopted containers — image source unknown. Use start/stop/restart only.');
    }

    const newImage = req.image ?? c.image;
    const newTag = req.tag ?? c.tag;
    const newResources: ContainerResources = {
        ...c.resources,
        ...req.resources,
    };
    // subdomain: undefined means "keep current"; explicit null means "remove";
    // a string value swaps to a new label.
    const newSubdomain =
        req.subdomain === undefined ? (c.subdomain ?? null) : req.subdomain;
    // domain: undefined keeps current; explicit value resolves against the list.
    const requestedDomain = req.domain === undefined ? c.domain : req.domain;
    const baseDomain = isReverseProxyEnabled() ? resolveDomain(requestedDomain) : null;

    logger.info({ containerId, newImage, newTag, newSubdomain, baseDomain }, 'redeploying container');

    assertHostAvailable(newSubdomain, baseDomain, containerId);
    await assertResourceBudget(newResources, containerId);

    // Stop + remove old Docker container
    await containerManager.stopContainer(c.dockerContainerId, 10);
    await containerManager.removeContainer(c.dockerContainerId, true);

    // Pull new image
    await containerManager.pullImage(newImage, newTag);

    // Reuse existing volumes — fetch from DB and pass mounts to new container
    const existingVolumeRows = volumesRepo.findByContainerId(containerId);
    const mounts = existingVolumeRows.map((v) => ({
        dockerVolumeName: v.dockerVolumeName,
        mountPath: v.mountPath,
    }));

    // Create + start new Docker container (preserve cluster id via appId)
    const newContainerName = buildContainerName({
        appId: c.appId,
        subdomain: newSubdomain,
        image: newImage,
    });
    const created = await containerManager.createAppContainer({
        id: containerId,
        appId: c.appId ?? c.id.slice(0, 12),
        containerName: newContainerName,
        image: newImage,
        tag: newTag,
        port: c.port,
        resources: newResources,
        envVars: c.envVars,
        mounts,
        subdomain: newSubdomain,
        baseDomain,
        createdAt: c.createdAt,
    });

    await containerManager.startContainer(created.containerId);

    const hostPort = await getHostPortWithRetry(created.containerId, c.port);
    const internalUrl = `http://localhost:${hostPort}`;

    const healthy = await waitForHealthy(internalUrl, 30_000);
    if (!healthy) {
        logger.warn({ containerId, internalUrl }, 'container did not become healthy within 30s after redeploy');
    }

    const now = Date.now();

    // Update DB row in-place: preserve cluster id, rotate docker details
    containersRepo.update(containerId, {
        dockerContainerId: created.containerId,
        dockerContainerName: created.containerName,
        image: newImage,
        tag: newTag,
        state: 'running',
        internalUrl,
        hostPort,
        resources: newResources,
        startedAt: now,
        stoppedAt: null,
        subdomain: newSubdomain,
        domain: baseDomain,
        healthCheck: {
            ...c.healthCheck,
            status: healthy ? 'healthy' : 'unknown',
            failCount: 0,
            lastCheck: now,
        },
    });

    const updated: Container = {
        ...c,
        dockerContainerId: created.containerId,
        dockerContainerName: created.containerName,
        image: newImage,
        tag: newTag,
        state: 'running',
        internalUrl,
        hostPort,
        resources: newResources,
        startedAt: now,
        stoppedAt: null,
        subdomain: newSubdomain,
        domain: baseDomain,
        healthCheck: {
            ...c.healthCheck,
            status: healthy ? 'healthy' : 'unknown',
            failCount: 0,
            lastCheck: now,
        },
        volumes: existingVolumeRows.map((v) => ({ name: v.name, mountPath: v.mountPath, sizeMb: v.sizeMb })),
    };

    sendEvent(eventFromContainer(updated, 'redeployed'));
    logger.info({ containerId, newDockerContainerId: created.containerId, internalUrl }, 'redeploy complete');
    return updated;
}

// ---------------------------------------------------------------------------
// rollingRedeployContainer
// ---------------------------------------------------------------------------

/**
 * Zero-downtime redeploy: create new container in parallel with old, switch traffic
 * atomically when new is healthy, then drain and remove old.
 *
 * Only safe when no persistent volumes — two containers writing to the same volume
 * would cause data corruption. Callers must check before invoking.
 */
export async function rollingRedeployContainer(containerId: string, req: RedeployRequest): Promise<Container> {
    const old = requireContainer(containerId);
    if (old.adopted) {
        throw new Error('Cannot redeploy adopted containers — image source unknown. Use start/stop/restart only.');
    }

    if (old.state !== 'running') {
        throw new Error(`Cannot rolling-redeploy a non-running container (state=${old.state}) — start it first`);
    }

    const newImage = req.image ?? old.image;
    const newTag = req.tag ?? old.tag;
    const newResources: ContainerResources = { ...old.resources, ...req.resources };
    const port = old.port;
    const newSubdomain =
        req.subdomain === undefined ? (old.subdomain ?? null) : req.subdomain;
    const requestedDomain = req.domain === undefined ? old.domain : req.domain;
    const baseDomain = isReverseProxyEnabled() ? resolveDomain(requestedDomain) : null;

    logger.info(
        { containerId, old: `${old.image}:${old.tag}`, new: `${newImage}:${newTag}`, newSubdomain, baseDomain },
        'rolling redeploy starting',
    );

    assertHostAvailable(newSubdomain, baseDomain, containerId);
    await assertResourceBudget(newResources, containerId);

    // 1. Pull new image — old container continues serving traffic
    await containerManager.pullImage(newImage, newTag);

    // 2. Create new container — buildContainerName already appends a unique
    //    hash so name collision with the still-running old container is impossible.
    let newDockerContainerId: string | null = null;
    let newDockerContainerName: string | null = null;

    try {
        const newContainerName = buildContainerName({
            appId: old.appId,
            subdomain: newSubdomain,
            image: newImage,
        });
        const created = await containerManager.createAppContainer({
            id: containerId,
            appId: old.appId ?? containerId.slice(0, 12),
            containerName: newContainerName,
            image: newImage,
            tag: newTag,
            port,
            resources: newResources,
            envVars: old.envVars,
            mounts: [], // volumes excluded — rolling is only allowed for volume-free containers
            subdomain: newSubdomain,
            baseDomain,
            createdAt: old.createdAt,
        });
        newDockerContainerId = created.containerId;
        newDockerContainerName = created.containerName;

        await containerManager.startContainer(newDockerContainerId);
        const newHostPort = await getHostPortWithRetry(newDockerContainerId, port);
        const newInternalUrl = `http://localhost:${newHostPort}`;

        const healthy = await waitForHealthy(newInternalUrl, 30_000);
        if (!healthy) {
            throw new Error('New container did not become healthy within 30s — aborting rolling redeploy');
        }

        // 3. Atomic swap: update DB pointer to new container.
        //    Subsequent dispatch calls will immediately route to the new container.
        const now = Date.now();
        const updatedContainer: Container = {
            ...old,
            dockerContainerId: newDockerContainerId,
            dockerContainerName: newDockerContainerName,
            image: newImage,
            tag: newTag,
            internalUrl: newInternalUrl,
            hostPort: newHostPort,
            resources: newResources,
            state: 'running',
            startedAt: now,
            stoppedAt: null,
            subdomain: newSubdomain,
            domain: baseDomain,
            healthCheck: {
                status: 'healthy',
                failCount: 0,
                restartCount: old.healthCheck.restartCount,
                lastCheck: now,
            },
        };

        containersRepo.update(containerId, {
            dockerContainerId: newDockerContainerId,
            dockerContainerName: newDockerContainerName,
            image: newImage,
            tag: newTag,
            internalUrl: newInternalUrl,
            hostPort: newHostPort,
            resources: newResources,
            state: 'running',
            startedAt: now,
            stoppedAt: null,
            subdomain: newSubdomain,
            domain: baseDomain,
            healthCheck: {
                status: 'healthy',
                failCount: 0,
                restartCount: old.healthCheck.restartCount,
                lastCheck: now,
            },
        });
        sendEvent(eventFromContainer(updatedContainer, 'redeployed'));

        // 4. Grace period: allow in-flight requests on old container to complete
        logger.info({ containerId }, 'rolling redeploy: traffic switched, draining old container (5s)');
        await new Promise<void>((r) => setTimeout(r, 5_000));

        // 5. Stop and remove old container (best-effort — new is already serving)
        try {
            await containerManager.stopContainer(old.dockerContainerId, 10);
            await containerManager.removeContainer(old.dockerContainerId, true);
            logger.info(
                { containerId, oldDockerId: old.dockerContainerId },
                'rolling redeploy: old container removed',
            );
        } catch (err: any) {
            logger.warn(
                { containerId, err: err.message },
                'rolling redeploy: old container cleanup failed (best-effort)',
            );
        }

        logger.info(
            { containerId, newDockerContainerId, newInternalUrl },
            'rolling redeploy complete',
        );
        return updatedContainer;
    } catch (err: any) {
        logger.error({ containerId, err: err.message }, 'rolling redeploy failed — cleaning up new container');
        if (newDockerContainerId) {
            try {
                await containerManager.stopContainer(newDockerContainerId, 5);
            } catch {
                // best-effort
            }
            try {
                await containerManager.removeContainer(newDockerContainerId, true);
            } catch {
                // best-effort
            }
        }
        throw err;
    }
}

// ---------------------------------------------------------------------------
// redeployContainerSmart — picks rolling vs stop-then-create
// ---------------------------------------------------------------------------

/**
 * Smart redeploy dispatcher: prefers zero-downtime rolling when safe, falls back
 * to legacy stop-then-create when rolling is not applicable.
 *
 * Rolling is skipped (with a log) when:
 *   - Caller passes `rolling: false` explicitly
 *   - App has persistent volumes (two writers → corruption risk)
 *   - Container is not currently running
 *
 * If rolling is attempted and fails, the error is thrown — no silent fallback to
 * stop-then-create, since that would cause unexpected downtime.
 */
export async function redeployContainerSmart(containerId: string, req: RedeployRequest): Promise<Container> {
    const old = requireContainer(containerId);
    if (old.adopted) {
        throw new Error('Cannot redeploy adopted containers — image source unknown. Use start/stop/restart only.');
    }
    const volumes = volumesRepo.findByContainerId(containerId);
    const wantRolling = req.rolling !== false; // default true when req.rolling is undefined

    if (wantRolling && volumes.length === 0 && old.state === 'running') {
        // Attempt rolling — throw on failure, don't silently fall back to downtime redeploy
        return rollingRedeployContainer(containerId, req);
    }

    // Fall back to legacy stop-then-create
    if (wantRolling) {
        const reason =
            volumes.length > 0
                ? `has ${volumes.length} persistent volume(s)`
                : `not running (state=${old.state})`;
        logger.info({ containerId, reason }, 'rolling unavailable, using stop-then-create redeploy');
    }
    return redeployContainer(containerId, req);
}

// ---------------------------------------------------------------------------
// adoptContainer
// ---------------------------------------------------------------------------

/**
 * Adopt an externally-created Docker container into the cluster.
 * Container must have label privos.mcp-app=true. Stopped containers are allowed —
 * MCP validation is deferred until the container is started.
 * Adoption is read-only from the image perspective — redeploy is blocked for adopted containers.
 */
export async function adoptContainer(dockerContainerId: string, appId?: string): Promise<Container> {
    // 1. Inspect Docker container
    let info: any;
    try {
        info = await containerManager.inspectContainer(dockerContainerId);
    } catch {
        throw new Error(`Container ${dockerContainerId} not found`);
    }

    const isRunning = info.State?.Running === true;

    // 2. Already adopted?
    const existing = containersRepo.findByDockerContainerId(info.Id);
    if (existing) {
        throw new Error(`Container already managed by cluster (id: ${existing.id})`);
    }

    // 3. Has privos.mcp-app=true label?
    const labels = info.Config?.Labels ?? {};
    if (labels['privos.mcp-app'] !== 'true') {
        throw new Error('Container missing required label privos.mcp-app=true');
    }

    // 4. Resolve port — priority: label > exposed ports
    let port: number | null = null;
    if (labels['privos.mcp-app.port']) {
        port = parseInt(labels['privos.mcp-app.port'], 10);
    } else {
        const exposed = Object.keys(info.Config?.ExposedPorts ?? {});
        const tcpPort = exposed.find((p) => p.endsWith('/tcp'));
        if (tcpPort) port = parseInt(tcpPort.split('/')[0], 10);
    }
    if (!port || isNaN(port)) {
        throw new Error('Container has no exposed TCP port and no privos.mcp-app.port label');
    }

    // 5. Resolve internalUrl + validate MCP — only if running. For stopped: deferred until start.
    let internalUrl = '';
    let hostPort: number | null = null;
    if (isRunning) {
        try {
            hostPort = await containerManager.getHostPort(info.Id, port);
            internalUrl = `http://localhost:${hostPort}`;
        } catch {
            const ip = await containerManager.getContainerIp(info.Id);
            if (!ip) throw new Error('Container has no host port mapping and no IP on mcp-apps-network');
            internalUrl = `http://${ip}:${port}`;
        }

        const healthy = await waitForHealthy(internalUrl, 5_000);
        if (!healthy) {
            throw new Error(
                'Container does not respond to MCP HTTP endpoints. ' +
                'Make sure container runs with MODE=http and exposes /health or /.well-known/mcp/manifest.json',
            );
        }
    }

    // 7. Read minimal env (safe keys only — avoid leaking secrets)
    const ALLOWED_ENV_KEYS = ['PORT', 'MODE', 'NODE_ENV'];
    const envArr = (info.Config?.Env ?? []) as string[];
    const envVars: Record<string, string> = {};
    for (const e of envArr) {
        const idx = e.indexOf('=');
        if (idx === -1) continue;
        const k = e.slice(0, idx);
        if (ALLOWED_ENV_KEYS.includes(k)) {
            envVars[k] = e.slice(idx + 1);
        }
    }

    // 8. Read resources from HostConfig
    const defaults = getDefaultResources();
    const memoryMb = info.HostConfig?.Memory
        ? Math.round(info.HostConfig.Memory / 1024 / 1024)
        : defaults.memoryMb;
    const cpus = info.HostConfig?.NanoCpus
        ? info.HostConfig.NanoCpus / 1e9
        : defaults.cpus;

    // 9. Parse image + tag from Image string
    const imageStr = info.Config?.Image ?? '';
    const lastColon = imageStr.lastIndexOf(':');
    const lastSlash = imageStr.lastIndexOf('/');
    let image: string, tag: string;
    if (lastColon > lastSlash && lastColon > -1) {
        image = imageStr.slice(0, lastColon);
        tag = imageStr.slice(lastColon + 1);
    } else {
        image = imageStr;
        tag = DEFAULT_TAG;
    }

    // 10. Build Container record
    const clusterId = crypto.randomUUID();
    const now = Date.now();
    const container: Container = {
        id: clusterId,
        appId: appId ?? labels['privos.mcp-app.name'] ?? null,
        dockerContainerId: info.Id,
        dockerContainerName: info.Name?.replace(/^\//, '') ?? '',
        image,
        tag,
        state: isRunning ? 'running' : 'stopped',
        internalUrl,
        port,
        hostPort,
        resources: { memoryMb, cpus, tmpSizeMb: defaults.tmpSizeMb },
        envVars,
        healthCheck: {
            status: isRunning ? 'healthy' : 'unknown',
            failCount: 0,
            restartCount: 0,
            lastCheck: isRunning ? now : null,
        },
        createdAt: info.Created ? new Date(info.Created).getTime() : now,
        startedAt: isRunning && info.State?.StartedAt ? new Date(info.State.StartedAt).getTime() : null,
        stoppedAt: !isRunning && info.State?.FinishedAt ? new Date(info.State.FinishedAt).getTime() : null,
        volumes: [],
        adopted: true,
    };

    containersRepo.insert(container);
    sendEvent(eventFromContainer(container, 'deployed'));

    logger.info({ clusterId, dockerContainerId: info.Id, image, tag }, 'container adopted');
    return container;
}

// ---------------------------------------------------------------------------
// deleteContainer
// ---------------------------------------------------------------------------

export async function deleteContainer(
    containerId: string,
    options: { detach?: boolean } = {},
): Promise<void> {
    const c = requireContainer(containerId);

    if (!options.detach) {
        logger.info({ containerId, dockerContainerId: c.dockerContainerId }, 'deleting container');

        try {
            await containerManager.stopContainer(c.dockerContainerId, 10);
        } catch (err: any) {
            logger.warn({ containerId, err: err.message }, 'stop failed during delete — continuing');
        }

        try {
            await containerManager.removeContainer(c.dockerContainerId, true);
        } catch (err: any) {
            logger.warn({ containerId, err: err.message }, 'remove failed during delete — continuing');
        }

        // Fetch volumes before deleting container (FK cascade would remove them, but we need names for Docker cleanup)
        const volumes = volumesRepo.findByContainerId(containerId);

        // Remove Docker named volumes (data loss by design — conservative approach)
        for (const vol of volumes) {
            try {
                await containerManager.removeVolume(vol.dockerVolumeName);
            } catch (err: any) {
                logger.warn({ containerId, volumeName: vol.dockerVolumeName, err: err.message }, 'failed to remove volume during delete — continuing');
            }
        }
    } else {
        logger.info({ containerId }, 'detach mode: keeping Docker container alive');
    }

    // Always: remove from SQLite + clean up volume rows + send event
    // Fetch volumes for explicit cleanup (cascade handles FK, but be explicit)
    const volumes = volumesRepo.findByContainerId(containerId);
    containersRepo.deleteById(containerId);
    volumesRepo.deleteByContainerId(containerId);

    // Build event from last known state
    sendEvent({
        event: 'deleted',
        containerId: c.id,
        dockerContainerId: c.dockerContainerId,
        appId: c.appId,
        state: 'stopped',
        healthStatus: c.healthCheck.status,
        internalUrl: c.internalUrl,
        hostPort: c.hostPort,
        ts: Date.now(),
        ...(options.detach ? { detached: true } : {}),
    } as any);

    logger.info({ containerId, detach: options.detach ?? false }, 'container deleted');
}
