import crypto from 'crypto';
import pino from 'pino';
import { config } from '../config.js';
import { containerManager, networkManager } from '../docker/index.js';
import * as dockerState from '../docker/docker-state.js';
import { getHealth } from './health-monitor.js';
import { checkResourceRequest } from './resource-check.js';
import {
    getDefaultResources,
    getImageRegistryAllowlist,
    isReverseProxyEnabled,
    resolveDomain,
	getAppNetworkName,
} from './settings-service.js';
import { mcpBrokerManager } from './mcp-broker.js';
import { refreshRoutes } from '../proxy/proxy-router.js';
import type { Container, ContainerResources, ContainerVolume, DeployRequest, RedeployRequest } from '../types/index.js';
import { canonicalJson } from '../security/artifacts.js';

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
// App containers are reachable only by their app-network address.
// ---------------------------------------------------------------------------

async function getInternalUrl(
    dockerContainerId: string,
    port: number,
    maxAttempts = 3,
): Promise<string> {
    let lastErr: Error | undefined;
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const ip = await containerManager.getContainerIp(dockerContainerId);
            if (ip) return `http://${ip}:${port}`;
            throw new Error('container has no app-network address');
        } catch (err: any) {
            lastErr = err;
            if (i < maxAttempts - 1) {
                await new Promise<void>((r) => setTimeout(r, 100));
            }
        }
    }
    throw lastErr;
}

function assertRegistryAllowed(image: string): void {
    const allowlist = getImageRegistryAllowlist();
    if (allowlist.length === 0) return;
    const first = image.split('/')[0] ?? '';
    const host = (first.includes('.') || first.includes(':') ? first : 'docker.io').toLowerCase();
    if (!allowlist.includes(host)) {
        const err: Error & { statusCode?: number } = new Error(`Registry is not allowed: ${host}`);
        err.statusCode = 403;
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Helper — load container (Docker labels are the source of truth) or 404
// ---------------------------------------------------------------------------

async function getContainerOr404(containerId: string, workspaceId?: string): Promise<Container> {
    const c = await dockerState.getById(containerId, getHealth, workspaceId);
    if (!c) {
        const err: Error & { statusCode?: number } = new Error(`Container not found: ${containerId}`);
        err.statusCode = 404;
        throw err;
    }
    return c;
}

/**
 * Derive the current named-volume mounts for a container from its own Docker
 * inspect (no volumes table — the container's Mounts array is the record).
 */
async function getExistingMounts(
    dockerContainerId: string,
): Promise<Array<{ dockerVolumeName: string; mountPath: string }>> {
    const info: any = await containerManager.inspectContainer(dockerContainerId);
    const mounts = (info.Mounts ?? []) as Array<{ Type?: string; Name?: string; Destination?: string }>;
    return mounts
        .filter((m) => m.Type === 'volume' && m.Name)
        .map((m) => ({ dockerVolumeName: m.Name as string, mountPath: m.Destination ?? '' }));
}

/**
 * Throws a 409-style Error if the full host (subdomain + domain) is already
 * taken by a different container. Uniqueness is per host, so the same subdomain
 * label can be reused under a different domain.
 */
async function assertHostAvailable(
    subdomain: string | null | undefined,
    domain: string | null,
    ignoreContainerId?: string,
): Promise<void> {
    if (!subdomain) return;
    const existing = await dockerState.findByHost(subdomain, domain);
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
        const existing = await dockerState.getById(ignoreContainerId);
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
    await networkManager.ensureNetwork(req.workspaceId);

    // Cluster always generates its own UUID for container naming (uniqueness).
    // req.appId is stored as metadata only.
    const clusterId = req.mcpV3Binding?.containerId ?? crypto.randomUUID();
	if (req.mcpV3Binding) {
		const existing = await dockerState.getById(clusterId, getHealth, req.workspaceId);
		if (existing) {
			const info = await containerManager.inspectContainer(existing.dockerContainerId);
			const labels = (info.Config?.Labels ?? {}) as Record<string, string>;
			const expected = {
				'privos.id': req.mcpV3Binding.containerId,
				'privos.app-id': req.appId ?? '',
				'privos.workspace': req.mcpV3Binding.workspaceId,
				'privos.image.digest': req.mcpV3Binding.imageDigest,
				'privos.mcp.schema': '3',
				'privos.mcp.cluster': req.mcpV3Binding.clusterId,
				'privos.mcp.node': req.mcpV3Binding.nodeId,
				'privos.mcp.workspace': req.mcpV3Binding.workspaceId,
				'privos.mcp.deployment': req.mcpV3Binding.deploymentId,
				'privos.mcp.generation': req.mcpV3Binding.generationId,
				'privos.mcp.generation-number': String(req.mcpV3Binding.generationNumber),
				'privos.mcp.runtime-installation': req.mcpV3Binding.runtimeInstallationId,
				'privos.mcp.app': req.mcpV3Binding.mcpAppId,
				'privos.mcp.replica': req.mcpV3Binding.replicaId,
				'privos.mcp.resource.kind': 'CONTAINER',
				'privos.mcp.resource.id': req.mcpV3Binding.containerId,
				'privos.mcp.image.digest': req.mcpV3Binding.imageDigest,
				'privos.mcp.manifest.digest': req.mcpV3Binding.manifestDigest,
				'privos.mcp.approval-receipt': req.mcpV3Binding.approvalReceiptHash,
				'privos.mcp.authorization-epoch': String(req.mcpV3Binding.authorizationEpoch),
				'privos.mcp.deployment-grant-hash': req.mcpV3Binding.deploymentGrantHash,
				'privos.mcp.resource-manifest-hash': req.mcpV3Binding.resourceManifestHash,
				'privos.mcp.hub-origin': req.mcpV3Binding.hubOrigin,
				'privos.mcp.hub-kid': req.mcpV3Binding.hubKid,
				'privos.mcp.hub-jwk': canonicalJson(req.mcpV3Binding.hubPublicJwk),
			};
			if (Object.entries(expected).some(([key, value]) => labels[key] !== value)) {
				throw new Error('existing_mcp_v3_container_binding_mismatch');
			}
			await mcpBrokerManager.restoreOrRegisterProvisioningV3({
				...req.mcpV3Binding,
				dockerContainerId: existing.dockerContainerId,
				networkName: getAppNetworkName(req.workspaceId),
				runtimeResourceInventoryHash: undefined,
			}, labels);
			if (existing.state !== 'running') {
				await containerManager.startContainer(existing.dockerContainerId);
				const resumed = await dockerState.getById(clusterId, getHealth, req.workspaceId);
				if (!resumed) throw new Error('mcp_v3_container_resume_failed');
				return resumed;
			}
			return existing;
		}
	}
    const shortId = clusterId.slice(0, 12);
    const image = req.image;
    const tag = req.tag ?? DEFAULT_TAG;
    const digest = req.digest;
    const port = req.port ?? DEFAULT_PORT;
    const resources: ContainerResources = {
        ...getDefaultResources(), // env-configured cluster defaults
        ...req.resources,
    };
    const envVars = req.envVars ?? {};
    const volumeSpecs: ContainerVolume[] = req.volumes ?? [];
    const subdomain = req.subdomain ?? null;
    // Resolve which base domain to publish under (validated against the configured list).
    const baseDomain = isReverseProxyEnabled() ? resolveDomain(req.domain) : null;

    logger.info(
        {
            clusterId,
            workspaceId: req.workspaceId,
            image,
            tag,
            port,
            volumeCount: volumeSpecs.length,
            subdomain,
            baseDomain,
        },
        'deploying managed app',
    );

    await assertHostAvailable(subdomain, baseDomain);
    await assertResourceBudget(resources);
    assertRegistryAllowed(image);

    await containerManager.pullImage(image, tag, digest);

    let dockerContainerId: string | null = null;
    const createdDockerVolumes: string[] = [];
	const brokerMount = req.mcpBinding || req.mcpV3Binding
		? await mcpBrokerManager.prepare((req.mcpBinding ?? req.mcpV3Binding)!.replicaId)
		: undefined;

    try {
        // Create Docker named volumes for each requested volume
        const mounts: Array<{ dockerVolumeName: string; mountPath: string }> = [];
        for (const vol of volumeSpecs) {
            const dockerVolumeName = req.workspaceId
                ? `privos-ws-${req.workspaceId}-app-${clusterId}-data`
                : `mcp-vol-${shortId}-${vol.name}`;
            await containerManager.ensureVolume(dockerVolumeName, vol.sizeMb, {
                'privos.workspace': req.workspaceId ?? '',
                'privos.app-id': clusterId,
            });
            createdDockerVolumes.push(dockerVolumeName);
            mounts.push({ dockerVolumeName, mountPath: vol.mountPath });
        }

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
            digest,
            workspaceId: req.workspaceId,
            listingId: req.listingId,
            versionDigest: req.versionDigest,
            port,
            resources,
            envVars,
            mounts,
            subdomain,
            baseDomain,
            createdAt,
			mcpBinding: req.mcpBinding,
			mcpV3Binding: req.mcpV3Binding,
			brokerMount,
        });
        dockerContainerId = created.containerId;
		if (req.mcpBinding) {
			await mcpBrokerManager.register({
				...req.mcpBinding,
				containerId: clusterId,
				dockerContainerId,
				networkName: getAppNetworkName(req.workspaceId),
			});
		} else if (req.mcpV3Binding) {
			if (req.mcpV3Binding.runtimeResourceInventoryHash !== undefined) {
				throw new Error('premature_runtime_inventory_claim');
			}
			await mcpBrokerManager.registerProvisioningV3({
				...req.mcpV3Binding,
				dockerContainerId,
				networkName: getAppNetworkName(req.workspaceId),
				runtimeResourceInventoryHash: undefined,
			});
		}

        await containerManager.startContainer(dockerContainerId);

        const internalUrl = await getInternalUrl(dockerContainerId, port);

        const healthy = await waitForHealthy(internalUrl, 30_000);
        if (!healthy) {
            logger.warn({ clusterId, internalUrl }, 'container did not become healthy within 30s — proceeding anyway');
        }

        // Docker (via the labels just written) is now the source of truth —
        // read the container back rather than hand-building the response.
        const container = await dockerState.getById(clusterId, getHealth, req.workspaceId);
        if (!container) {
            throw new Error(`Deployed container ${clusterId} not found immediately after creation`);
        }

        logger.info({ clusterId, dockerContainerId, internalUrl }, 'deploy complete');
        refreshRoutes(); // new host is now routable in the native proxy
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
		if (req.mcpBinding || req.mcpV3Binding) {
			await mcpBrokerManager.cleanup((req.mcpBinding ?? req.mcpV3Binding)!.replicaId).catch(() => undefined);
		}
        throw err;
    }
}

// ---------------------------------------------------------------------------
// startContainer
// ---------------------------------------------------------------------------

export async function startContainer(containerId: string, workspaceId?: string): Promise<Container> {
    const c = await getContainerOr404(containerId, workspaceId);

    logger.info({ containerId, dockerContainerId: c.dockerContainerId }, 'starting container');

    await containerManager.startContainer(c.dockerContainerId);

    // Port mapping changes after stop/start
    const internalUrl = await getInternalUrl(c.dockerContainerId, c.port);

    const healthy = await waitForHealthy(internalUrl, 30_000);
    if (!healthy) {
        logger.warn({ containerId, internalUrl }, 'container did not become healthy within 30s');
    }

    const updated = await dockerState.getById(containerId, getHealth, workspaceId);
    if (!updated) throw new Error(`Container not found after start: ${containerId}`);
    refreshRoutes(); // running state changed — re-evaluate the health gate
    return updated;
}

// ---------------------------------------------------------------------------
// stopContainer
// ---------------------------------------------------------------------------

export async function stopContainer(containerId: string, workspaceId?: string): Promise<Container> {
    const c = await getContainerOr404(containerId, workspaceId);

    logger.info({ containerId, dockerContainerId: c.dockerContainerId }, 'stopping container');

    await containerManager.stopContainer(c.dockerContainerId, 10);

    const updated = await dockerState.getById(containerId, getHealth, workspaceId);
    if (!updated) throw new Error(`Container not found after stop: ${containerId}`);
    refreshRoutes(); // stopped container must stop routing (health gate → 502)
    return updated;
}

// ---------------------------------------------------------------------------
// restartContainer
// ---------------------------------------------------------------------------

export async function restartContainer(containerId: string, workspaceId?: string): Promise<Container> {
    const c = await getContainerOr404(containerId, workspaceId);

    logger.info({ containerId, dockerContainerId: c.dockerContainerId }, 'restarting container');

    await containerManager.restartContainer(c.dockerContainerId);

    // Port mapping may change after restart
    const internalUrl = await getInternalUrl(c.dockerContainerId, c.port);

    const healthy = await waitForHealthy(internalUrl, 30_000);
    if (!healthy) {
        logger.warn({ containerId, internalUrl }, 'container did not become healthy within 30s after restart');
    }

    const updated = await dockerState.getById(containerId, getHealth, workspaceId);
    if (!updated) throw new Error(`Container not found after restart: ${containerId}`);
    refreshRoutes(); // host port may change after restart — drop the stale target
    return updated;
}

// ---------------------------------------------------------------------------
// redeployContainer
// ---------------------------------------------------------------------------

export async function redeployContainer(
    containerId: string,
    req: RedeployRequest,
    workspaceId?: string,
): Promise<Container> {
    const c = await getContainerOr404(containerId, workspaceId);

    const newImage = req.image ?? c.image;
    const newTag = req.tag ?? c.tag;
    const newDigest = req.digest;
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

    await assertHostAvailable(newSubdomain, baseDomain, containerId);
    await assertResourceBudget(newResources, containerId);
    assertRegistryAllowed(newImage);

    // Read existing volume mounts from the OLD container's own inspect before
    // it's removed — there is no volumes table to query anymore.
    const mounts = await getExistingMounts(c.dockerContainerId);

    // Pull the new image FIRST — it's the most likely failure (bad tag, registry
    // down/auth) and is non-destructive. Only tear down the old container once we
    // know the new image is available; otherwise a pull failure would leave the
    // app with no container carrying its privos.id (gone from GET /apps, no rollback).
    await containerManager.pullImage(newImage, newTag, newDigest);

    // Stop + remove old Docker container
    await containerManager.stopContainer(c.dockerContainerId, 10);
    await containerManager.removeContainer(c.dockerContainerId, true);

    // Create + start new Docker container (preserve cluster id via the id label)
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
        digest: newDigest,
        workspaceId: c.workspaceId ?? undefined,
        listingId: c.listingId ?? undefined,
        versionDigest: req.versionDigest ?? c.versionDigest ?? undefined,
        port: c.port,
        resources: newResources,
        envVars: c.envVars,
        mounts,
        subdomain: newSubdomain,
        baseDomain,
        createdAt: c.createdAt,
    });

    await containerManager.startContainer(created.containerId);

    const internalUrl = await getInternalUrl(created.containerId, c.port);

    const healthy = await waitForHealthy(internalUrl, 30_000);
    if (!healthy) {
        logger.warn({ containerId, internalUrl }, 'container did not become healthy within 30s after redeploy');
    }

    const updated = await dockerState.getById(containerId, getHealth, workspaceId);
    if (!updated) throw new Error(`Container not found after redeploy: ${containerId}`);
    logger.info({ containerId, newDockerContainerId: created.containerId, internalUrl }, 'redeploy complete');
    refreshRoutes(); // new container id / host port — invalidate the cached target
    return updated;
}

// ---------------------------------------------------------------------------
// rollingRedeployContainer — zero-downtime
// ---------------------------------------------------------------------------

/**
 * Zero-downtime redeploy: pull + start the new container alongside the old,
 * wait until it's healthy, then drain and remove the old one.
 *
 * Only safe when there are no persistent volumes (two writers to one volume →
 * corruption). During the brief overlap both containers share the same
 * `privos.id`/`privos.subdomain` labels; docker-state's pickActivePerId resolves
 * that to a single active container (prefer running → newest), so the API view
 * stays single-identity. Caddy has both as upstreams during the window.
 */
export async function rollingRedeployContainer(
    containerId: string,
    req: RedeployRequest,
    workspaceId?: string,
): Promise<Container> {
    const old = await getContainerOr404(containerId, workspaceId);

    if (old.state !== 'running') {
        throw new Error(`Cannot rolling-redeploy a non-running container (state=${old.state}) — start it first`);
    }

    const newImage = req.image ?? old.image;
    const newTag = req.tag ?? old.tag;
    const newDigest = req.digest;
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

    await assertHostAvailable(newSubdomain, baseDomain, containerId);
    await assertResourceBudget(newResources, containerId);
    assertRegistryAllowed(newImage);

    // 1. Pull new image — old container continues serving traffic
    await containerManager.pullImage(newImage, newTag, newDigest);

    // 2. Create + start the new container. buildContainerName appends a unique
    //    hash so it never collides with the still-running old container.
    let newDockerContainerId: string | null = null;
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
            digest: newDigest,
            workspaceId: old.workspaceId ?? undefined,
            listingId: old.listingId ?? undefined,
            versionDigest: req.versionDigest ?? old.versionDigest ?? undefined,
            port,
            resources: newResources,
            envVars: old.envVars,
            mounts: [], // volumes excluded — rolling is only allowed for volume-free containers
            subdomain: newSubdomain,
            baseDomain,
            createdAt: old.createdAt,
        });
        newDockerContainerId = created.containerId;

        await containerManager.startContainer(newDockerContainerId);
        const newInternalUrl = await getInternalUrl(newDockerContainerId, port);

        const healthy = await waitForHealthy(newInternalUrl, 30_000);
        if (!healthy) {
            throw new Error('New container did not become healthy within 30s — aborting rolling redeploy');
        }

        // 3. Grace period: let in-flight requests on the old container complete.
        logger.info({ containerId }, 'rolling redeploy: new container healthy, draining old (5s)');
        await new Promise<void>((r) => setTimeout(r, 5_000));

        // 4. Stop + remove the old container (best-effort — new already serves).
        try {
            await containerManager.stopContainer(old.dockerContainerId, 10);
            await containerManager.removeContainer(old.dockerContainerId, true);
            logger.info({ containerId, oldDockerId: old.dockerContainerId }, 'rolling redeploy: old container removed');
        } catch (err: any) {
            logger.warn({ containerId, err: err.message }, 'rolling redeploy: old container cleanup failed (best-effort)');
        }

        const updated = await dockerState.getById(containerId, getHealth, workspaceId);
        if (!updated) throw new Error(`Container not found after rolling redeploy: ${containerId}`);
        logger.info({ containerId, newDockerContainerId, newInternalUrl }, 'rolling redeploy complete');
        refreshRoutes(); // swap to the new container id / host port
        return updated;
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
 * Prefer zero-downtime rolling; fall back to stop-then-create when rolling is
 * unsafe/inapplicable: caller passed `rolling:false`, the app has persistent
 * volumes (two writers → corruption), or the container isn't running. On a
 * rolling failure the error propagates — no silent downtime fallback.
 */
export async function redeployContainerSmart(
    containerId: string,
    req: RedeployRequest,
    workspaceId?: string,
): Promise<Container> {
    const old = await getContainerOr404(containerId, workspaceId);
    const wantRolling = req.rolling !== false;

    if (wantRolling && old.volumes.length === 0 && old.state === 'running') {
        return rollingRedeployContainer(containerId, req, workspaceId);
    }

    if (wantRolling) {
        const reason =
            old.volumes.length > 0 ? `has ${old.volumes.length} persistent volume(s)` : `not running (state=${old.state})`;
        logger.info({ containerId, reason }, 'rolling unavailable, using stop-then-create redeploy');
    }
    return redeployContainer(containerId, req, workspaceId);
}

// ---------------------------------------------------------------------------
// deleteContainer
// ---------------------------------------------------------------------------

/**
 * Stop, remove, and clean up a managed container's Docker volumes.
 * Labels are immutable — there is no "detach" (unmanage-without-removing)
 * option anymore; delete always stops and removes the Docker container.
 */
export async function deleteContainer(containerId: string, workspaceId?: string): Promise<void> {
    const c = await getContainerOr404(containerId, workspaceId);

    logger.info({ containerId, dockerContainerId: c.dockerContainerId }, 'deleting container');

    // Derive volume names from the container's own mounts before it's removed
    // — there is no volumes table to fall back on.
    let volumeNames: string[] = [];
	let mcpReplicaId: string | undefined;
    try {
		const info = await containerManager.inspectContainer(c.dockerContainerId);
		mcpReplicaId = info.Config?.Labels?.['privos.mcp.replica'];
        const mounts = await getExistingMounts(c.dockerContainerId);
        volumeNames = mounts.map((m) => m.dockerVolumeName);
    } catch (err: any) {
        logger.warn({ containerId, err: err.message }, 'inspect failed before delete — skipping volume cleanup');
    }

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

    // Remove Docker named volumes (data loss by design — conservative approach)
    const volumeErrors: Error[] = [];
    for (const volName of volumeNames) {
        try {
            await containerManager.removeVolume(volName);
        } catch (err: any) {
            logger.error({ containerId, volumeName: volName, err: err.message }, 'failed to remove volume during delete');
            volumeErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
    }
	if (mcpReplicaId) await mcpBrokerManager.cleanup(mcpReplicaId).catch(() => undefined);

    logger.info({ containerId }, 'container deleted');
    refreshRoutes(); // host no longer resolves — stop routing to the removed container
    if (volumeErrors.length > 0) {
        const err: Error & { statusCode?: number; volumes?: string[] } = new Error(
            `Container removed but ${volumeErrors.length} volume(s) require reconciliation`,
        );
        err.statusCode = 500;
        err.volumes = volumeNames;
        throw err;
    }
}
