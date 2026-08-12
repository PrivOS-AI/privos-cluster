import crypto from 'crypto';
import pino from 'pino';
import { config } from '../config.js';
import { containerManager, networkManager } from '../docker/index.js';
import { imageRepositoryOf } from '../docker/image-reference.js';
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
import type {
	Container,
	ContainerResources,
	ContainerVolume,
	DeployRequest,
	McpRuntimeBindingV3,
	RedeployRequest,
} from '../types/index.js';
import type { JsonWebKey } from 'node:crypto';
import { canonicalJson } from '../security/artifacts.js';
import { assertRawRedeployAllowedForLabels } from './redeploy-secret-guard.js';

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
            platformEnvVars: req.platformEnvVars,
            secretEnvKeys: req.secretEnvKeys,
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
// reconfigureManagedAppV3
// ---------------------------------------------------------------------------

/**
 * Recreate one already-provisioned v3 replica with a new environment.
 *
 * The container keeps its cluster identity (`privos.id`), so the generation's
 * hash-pinned runtime resource inventory stays exactly as attested — this is a
 * configuration change, never a new generation. Everything else about the
 * container is rebuilt from the request, which the master derived from the
 * verified reconfigure command; a request that disagrees with the labels the
 * container already carries is refused before anything is torn down.
 */
export async function reconfigureManagedAppV3(
	req: Omit<DeployRequest, 'mcpV3Binding'> & {
		mcpV3Binding: Omit<McpRuntimeBindingV3, 'hubOrigin' | 'hubKid' | 'hubPublicJwk'>;
		runtimeResourceInventoryHash: string;
	},
): Promise<Container> {
	const clusterId = req.mcpV3Binding.containerId;
	const existing = await getContainerOr404(clusterId, req.workspaceId);
	const inspect = await containerManager.inspectContainer(existing.dockerContainerId);
	const labels = (inspect.Config?.Labels ?? {}) as Record<string, string>;
	const expected = {
		'privos.id': req.mcpV3Binding.containerId,
		'privos.workspace': req.mcpV3Binding.workspaceId,
		'privos.image.digest': req.mcpV3Binding.imageDigest,
		'privos.mcp.schema': '3',
		'privos.mcp.cluster': req.mcpV3Binding.clusterId,
		'privos.mcp.node': req.mcpV3Binding.nodeId,
		'privos.mcp.deployment': req.mcpV3Binding.deploymentId,
		'privos.mcp.generation': req.mcpV3Binding.generationId,
		'privos.mcp.generation-number': String(req.mcpV3Binding.generationNumber),
		'privos.mcp.runtime-installation': req.mcpV3Binding.runtimeInstallationId,
		'privos.mcp.app': req.mcpV3Binding.mcpAppId,
		'privos.mcp.replica': req.mcpV3Binding.replicaId,
		'privos.mcp.manifest.digest': req.mcpV3Binding.manifestDigest,
		'privos.mcp.resource-manifest-hash': req.mcpV3Binding.resourceManifestHash,
		'privos.mcp.approval-receipt': req.mcpV3Binding.approvalReceiptHash,
		'privos.mcp.authorization-epoch': String(req.mcpV3Binding.authorizationEpoch),
		'privos.mcp.deployment-grant-hash': req.mcpV3Binding.deploymentGrantHash,
	};
	if (Object.entries(expected).some(([key, value]) => labels[key] !== value)) {
		throw new Error('mcp_v3_reconfigure_binding_mismatch');
	}
	let hubPublicJwk: JsonWebKey;
	try {
		hubPublicJwk = JSON.parse(labels['privos.mcp.hub-jwk'] ?? '') as JsonWebKey;
	} catch {
		throw new Error('mcp_v3_reconfigure_binding_mismatch');
	}
	const binding: McpRuntimeBindingV3 = {
		...req.mcpV3Binding,
		hubOrigin: labels['privos.mcp.hub-origin']!,
		hubKid: labels['privos.mcp.hub-kid']!,
		hubPublicJwk,
	};

	const port = req.port ?? existing.port;
	const mounts = await getExistingMounts(existing.dockerContainerId);
	const baseDomain = isReverseProxyEnabled() ? resolveDomain(req.domain ?? existing.domain) : null;
	const subdomain = req.subdomain ?? existing.subdomain ?? null;

	logger.info(
		{ clusterId, replicaId: req.mcpV3Binding.replicaId, envKeys: Object.keys(req.envVars ?? {}).sort() },
		'reconfiguring managed v3 app',
	);

	// The image is already local (this generation is running on it), but pull by
	// digest anyway so a pruned layer fails BEFORE the running container is gone.
	await containerManager.pullImage(req.image, req.tag ?? DEFAULT_TAG, req.digest);
	await mcpBrokerManager.cleanup(req.mcpV3Binding.replicaId);
	await containerManager.stopContainer(existing.dockerContainerId, 10);
	await containerManager.removeContainer(existing.dockerContainerId, true);

	const brokerMount = await mcpBrokerManager.prepare(req.mcpV3Binding.replicaId);
	const created = await containerManager.createAppContainer({
		id: clusterId,
		appId: req.appId ?? clusterId.slice(0, 12),
		containerName: buildContainerName({ appId: req.appId, subdomain, image: req.image }),
		image: req.image,
		tag: req.tag ?? DEFAULT_TAG,
		digest: req.digest,
		workspaceId: req.workspaceId,
		listingId: req.listingId,
		versionDigest: req.versionDigest,
		port,
		resources: { ...getDefaultResources(), ...req.resources },
		envVars: req.envVars ?? {},
		platformEnvVars: req.platformEnvVars,
		secretEnvKeys: req.secretEnvKeys,
		mounts,
		subdomain,
		baseDomain,
		mcpV3Binding: binding,
		brokerMount,
	});
	// Re-establish the finalized broker binding: the socket was torn down with
	// the old container, and dispatch stays refused until the inventory hash the
	// generation was attested under is restored.
	await mcpBrokerManager.register({
		...binding,
		dockerContainerId: created.containerId,
		networkName: getAppNetworkName(req.workspaceId),
		runtimeResourceInventoryHash: req.runtimeResourceInventoryHash,
	});
	await containerManager.startContainer(created.containerId);

	const internalUrl = await getInternalUrl(created.containerId, port);
	if (!(await waitForHealthy(internalUrl, 30_000))) {
		logger.warn({ clusterId, internalUrl }, 'container did not become healthy within 30s after reconfigure');
	}

	const container = await dockerState.getById(clusterId, getHealth, req.workspaceId);
	if (!container) throw new Error(`Container not found after reconfigure: ${clusterId}`);
	logger.info({ clusterId, dockerContainerId: created.containerId }, 'reconfigure complete');
	refreshRoutes();
	return container;
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

/** Inspect a container and apply the raw-redeploy secret guard to its labels. */
async function assertRawRedeployAllowed(
	dockerContainerId: string,
	upgrade?: { envVars: Record<string, string>; secretEnvKeys: string[]; platformEnvVars: Record<string, string> },
): Promise<void> {
	const info = await containerManager.inspectContainer(dockerContainerId);
	assertRawRedeployAllowedForLabels((info.Config?.Labels ?? {}) as Record<string, string>, upgrade);
}

/**
 * The container an upgrade is about to replace must be *the same container* the master
 * named. Checked against the OLD container's own labels before anything is pulled or torn
 * down, so a redeploy can never land on a neighbour.
 *
 * Only IDENTITY is a precondition. The binding also carries what the upgrade is about to
 * WRITE — image and manifest digest (D1), and the post-swap attestation values: the
 * authorization epoch, the approval receipt, the deployment grant and the resource-manifest
 * hash. Those describe the new container, not the old one, so comparing them here refuses
 * exactly the upgrades that change anything.
 *
 * That is not hypothetical. Since the master began sending the POST-swap epoch (the
 * 2026-08-08 fix that made upgraded runtimes pairable at all), every upgrade that rotated
 * the epoch hit `mcp_v3_upgrade_binding_mismatch` on the old container's epoch label — the
 * agent comparing 1 against the 2 it was about to write. The Hub verifies those values where
 * they belong: in the new runtime's own attestation at cutover.
 */
function assertMcpV3UpgradeAffinity(
	labels: Record<string, string>,
	containerId: string,
	binding: NonNullable<RedeployRequest['mcpV3Binding']>,
): void {
	const expected: Record<string, string> = {
		'privos.id': containerId,
		'privos.workspace': binding.workspaceId,
		'privos.mcp.schema': '3',
		'privos.mcp.cluster': binding.clusterId,
		'privos.mcp.node': binding.nodeId,
		'privos.mcp.deployment': binding.deploymentId,
		'privos.mcp.generation': binding.generationId,
		'privos.mcp.generation-number': String(binding.generationNumber),
		'privos.mcp.runtime-installation': binding.runtimeInstallationId,
		'privos.mcp.app': binding.mcpAppId,
		'privos.mcp.replica': binding.replicaId,
	};
	if (Object.entries(expected).some(([key, value]) => labels[key] !== value)) {
		throw new Error('mcp_v3_upgrade_binding_mismatch');
	}
}

/**
 * Reconstruct the full v3 binding for the container's NEW image, reusing the
 * Hub identity the generation was provisioned under — immutable, read from the
 * OLD container's own labels, never restated by an upgrade (mirrors
 * reconfigureManagedAppV3's identical reasoning).
 */
function buildMcpV3UpgradeBinding(
	labels: Record<string, string>,
	binding: NonNullable<RedeployRequest['mcpV3Binding']>,
): McpRuntimeBindingV3 {
	let hubPublicJwk: JsonWebKey;
	try {
		hubPublicJwk = JSON.parse(labels['privos.mcp.hub-jwk'] ?? '') as JsonWebKey;
	} catch {
		throw new Error('mcp_v3_upgrade_binding_mismatch');
	}
	return {
		...binding,
		hubOrigin: labels['privos.mcp.hub-origin']!,
		hubKid: labels['privos.mcp.hub-kid']!,
		hubPublicJwk,
	};
}

// Exported for direct testing (see lifecycle-service-mcp-v3-swap.test.ts) — the
// forward-then-recover sequence this function makes safe is exactly the
// scenario that needs proving with a real (Docker-mocked) failure, not just a
// type check.
export type McpV3SwapContext = {
    binding: McpRuntimeBindingV3;
    runtimeResourceInventoryHash: string;
    platformEnvVars: Record<string, string> | undefined;
    secretEnvKeys: string[] | undefined;
};

/**
 * One create + (broker register) + start + health-poll attempt. Shared by the
 * forward swap and its failure recovery below so there is exactly one place
 * that knows how to stand a redeployed container up.
 *
 * Self-cleaning on failure: if anything after `createAppContainer` throws, the
 * container this attempt just created is stopped and removed, and (for an MCP
 * v3 attempt) the broker directory this attempt just wrote to is cleared —
 * mirroring rollingRedeployContainer's own new-container cleanup on failure.
 * This is what makes a SECOND attempt (recovery) safe to run immediately
 * after: without it, a failed attempt that got as far as `register()` leaves
 * `binding-v3.json` holding THIS attempt's digest, and the next attempt's own
 * `register()` call refuses to overwrite a binding that disagrees with what
 * it's given (`persisted_mcp_v3_broker_binding_conflict`) — the revert would
 * throw every time a failure happened after the broker was written. And
 * without removing the orphaned container, a second create for the same
 * `privos.id` produces TWO live containers sharing one volume set — the exact
 * corruption class the volume check exists to prevent, just reached through
 * the recovery path instead of a rolling overlap.
 */
export async function createAndStartRedeployedContainer(params: {
    containerId: string;
    appId: string | null;
    containerName: string;
    image: string;
    tag: string;
    digest: string | undefined;
    workspaceId: string | undefined;
    listingId: string | undefined;
    versionDigest: string | undefined;
    port: number;
    resources: ContainerResources;
    envVars: Record<string, string>;
    mounts: Array<{ dockerVolumeName: string; mountPath: string }>;
    subdomain: string | null;
    baseDomain: string | null;
    createdAt: number;
    mcp?: McpV3SwapContext;
}): Promise<Container> {
    const brokerMount = params.mcp ? await mcpBrokerManager.prepare(params.mcp.binding.replicaId) : undefined;
    let created: { containerId: string; containerName: string; hostPort: number } | undefined;
    try {
        created = await containerManager.createAppContainer({
            id: params.containerId,
            appId: params.appId ?? params.containerId.slice(0, 12),
            containerName: params.containerName,
            image: params.image,
            tag: params.tag,
            digest: params.digest,
            workspaceId: params.workspaceId,
            listingId: params.listingId,
            versionDigest: params.versionDigest,
            port: params.port,
            resources: params.resources,
            envVars: params.envVars,
            platformEnvVars: params.mcp?.platformEnvVars,
            secretEnvKeys: params.mcp?.secretEnvKeys,
            mounts: params.mounts,
            subdomain: params.subdomain,
            baseDomain: params.baseDomain,
            createdAt: params.createdAt,
            mcpV3Binding: params.mcp?.binding,
            brokerMount,
        });
        if (params.mcp) {
            // Re-establish the finalized broker binding: the socket was torn down
            // with the container it replaces, and dispatch stays refused until the
            // inventory hash the generation was attested under is restored.
            await mcpBrokerManager.register({
                ...params.mcp.binding,
                dockerContainerId: created.containerId,
                networkName: getAppNetworkName(params.workspaceId),
                runtimeResourceInventoryHash: params.mcp.runtimeResourceInventoryHash,
            });
        }
        await containerManager.startContainer(created.containerId);
        const internalUrl = await getInternalUrl(created.containerId, params.port);
        const healthy = await waitForHealthy(internalUrl, 30_000);
        if (!healthy) {
            logger.warn({ containerId: params.containerId, internalUrl }, 'container did not become healthy within 30s after redeploy');
        }
        if (params.mcp) {
            // The readiness bar for an MCP v3 upgrade is deliberately NOT the
            // /health HTTP endpoint above (D4) — it is known to report unhealthy
            // for a genuinely correct app (SDK-vs-broker version skew). But
            // "started, then exited" is a DIFFERENT, unambiguous signal: Docker's
            // own process state, not the app's opinion of itself, and this
            // container's RestartPolicy is 'no' so a crash shows up as a durable
            // `exited` status rather than a transient blip. Install/reconfigure
            // have no equivalent check today either — this is additive, not a
            // narrowing of what already passed for them.
            const postStart = await containerManager.inspectContainer(created.containerId);
            if (postStart.State?.Status !== 'running') {
                throw new Error(`container exited after start (state=${postStart.State?.Status ?? 'unknown'}) — new image did not come up`);
            }
        }
        const updated = await dockerState.getById(params.containerId, getHealth, params.workspaceId);
        if (!updated) throw new Error(`Container not found after redeploy: ${params.containerId}`);
        return updated;
    } catch (err: any) {
        logger.error({ containerId: params.containerId, err: err.message }, 'container create/start attempt failed — cleaning up before any retry');
        if (created) {
            try {
                await containerManager.stopContainer(created.containerId, 5);
            } catch {
                // best-effort
            }
            try {
                await containerManager.removeContainer(created.containerId, true);
            } catch {
                // best-effort
            }
        }
        if (params.mcp) {
            // Clears the socket AND binding-v3.json so the next attempt for this
            // replicaId — a recovery included — registers fresh instead of
            // conflicting with what this failed attempt already wrote.
            await mcpBrokerManager.cleanup(params.mcp.binding.replicaId).catch(() => undefined);
        }
        throw err;
    }
}

export async function redeployContainer(
    containerId: string,
    req: RedeployRequest,
    workspaceId?: string,
): Promise<Container> {
    const c = await getContainerOr404(containerId, workspaceId);
    await assertRawRedeployAllowed(c.dockerContainerId, req.mcpV3Binding ? {
        envVars: req.envVars ?? {},
        secretEnvKeys: req.secretEnvKeys ?? [],
        platformEnvVars: req.platformEnvVars ?? {},
    } : undefined);

    // A caller supplying a NEW digest is deliberately moving off the digest the
    // container currently runs, so fall back to the repository rather than the
    // running pinned reference — otherwise the pull refuses its own disagreeing
    // pin and the redeploy fails before anything is touched.
    const newImage = req.image ?? (req.digest ? imageRepositoryOf(c.image) : c.image);
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

    // An MCP v3 upgrade must find the container it is about to replace exactly
    // where the signed command expects it, verified against the OLD container's
    // own labels before anything downstream is touched. The OLD image/manifest
    // digest is captured here too — read off this same inspect, never
    // recomputed — so a failed swap has a named way back (D4).
    let mcpV3Binding: McpRuntimeBindingV3 | undefined;
    let mcpV3PreviousBinding: McpRuntimeBindingV3 | undefined;
    let runtimeResourceInventoryHash: string | undefined;
    if (req.mcpV3Binding) {
        const inspected = await containerManager.inspectContainer(c.dockerContainerId);
        const labels = (inspected.Config?.Labels ?? {}) as Record<string, string>;
        assertMcpV3UpgradeAffinity(labels, containerId, req.mcpV3Binding);
        mcpV3Binding = buildMcpV3UpgradeBinding(labels, req.mcpV3Binding);
        mcpV3PreviousBinding = {
            ...mcpV3Binding,
            imageDigest: labels['privos.mcp.image.digest']!,
            manifestDigest: labels['privos.mcp.manifest.digest']!,
        };
        runtimeResourceInventoryHash = req.runtimeResourceInventoryHash;
        if (!runtimeResourceInventoryHash) throw new Error('mcp_v3_upgrade_inventory_hash_required');
    }
    const mcpContext: McpV3SwapContext | undefined = mcpV3Binding ? {
        binding: mcpV3Binding,
        // Guaranteed set: mcpV3Binding is only assigned once
        // runtimeResourceInventoryHash has already been checked truthy above.
        runtimeResourceInventoryHash: runtimeResourceInventoryHash!,
        platformEnvVars: req.platformEnvVars,
        secretEnvKeys: req.secretEnvKeys,
    } : undefined;

    // Pull the new image FIRST — it's the most likely failure (bad tag, registry
    // down/auth) and is non-destructive. Only tear down the old container once we
    // know the new image is available; otherwise a pull failure would leave the
    // app with no container carrying its privos.id (gone from GET /apps, no rollback).
    await containerManager.pullImage(newImage, newTag, newDigest);

    // For an MCP v3 upgrade, ALSO pre-pull the PREVIOUS image now, before the old
    // container is touched — not only after a failure. The old container being
    // currently up does not guarantee its image stays resident: it can be
    // pruned, and on an HA replica running on a node that only recently joined
    // the set, it may never have been pulled there at all. If recovery ever
    // needs it and this pull is missing, the restore itself fails — the exact
    // way a benign refusal turns into a permanently bricked installation. This
    // is non-destructive, same as the forward pull above.
    if (mcpV3PreviousBinding) {
        await containerManager.pullImage(c.image, c.tag, mcpV3PreviousBinding.imageDigest);
    }

    // Stop + remove the OLD Docker container FIRST, and only clear its broker
    // binding once that has actually succeeded. Doing it in the other order
    // (as an earlier version of this function did) leaves a window where a
    // stop/remove failure is thrown with the broker socket ALREADY torn down:
    // the old container would still be running — GET /apps, docker ps, and
    // Mongo all still show it healthy — but every dispatch into it fails
    // permanently, with nothing to notice or recover it (the reconciler skips
    // mcp-v3 containers). Clearing the broker only after removal is confirmed
    // means that window cannot open.
    await containerManager.stopContainer(c.dockerContainerId, 10);
    await containerManager.removeContainer(c.dockerContainerId, true);
    if (mcpV3Binding) await mcpBrokerManager.cleanup(mcpV3Binding.replicaId);

    // Create + start new Docker container (preserve cluster id via the id label)
    const newContainerName = buildContainerName({
        appId: c.appId,
        subdomain: newSubdomain,
        image: newImage,
    });
    // A generic (non-MCP) redeploy never changes env, so the label's
    // non-secret reconstruction is safe to reuse. An MCP v3 upgrade instead
    // uses the FULL environment the master sent alongside the signed command —
    // see RedeployRequest's comment on why that is required.
    const swapEnvVars = mcpV3Binding ? (req.envVars ?? {}) : c.envVars;

    try {
        const updated = await createAndStartRedeployedContainer({
            containerId,
            appId: c.appId,
            containerName: newContainerName,
            image: newImage,
            tag: newTag,
            digest: newDigest,
            workspaceId: c.workspaceId ?? undefined,
            listingId: c.listingId ?? undefined,
            versionDigest: req.versionDigest ?? c.versionDigest ?? undefined,
            port: c.port,
            resources: newResources,
            envVars: swapEnvVars,
            mounts,
            subdomain: newSubdomain,
            baseDomain,
            createdAt: c.createdAt,
            mcp: mcpContext,
        });
        logger.info({ containerId, newDockerContainerId: updated.dockerContainerId }, 'redeploy complete');
        refreshRoutes(); // new container id / host port — invalidate the cached target
        return updated;
    } catch (err: any) {
        logger.error({ containerId, err: err.message }, 'redeploy failed after the old container was removed');
        // Only an MCP v3 upgrade carries a named revert target (D4) — a plain
        // redeploy has never had one, and inventing a guess here would be worse
        // than propagating the failure as-is.
        if (!mcpV3PreviousBinding || !mcpContext) throw err;
        try {
            await createAndStartRedeployedContainer({
                containerId,
                appId: c.appId,
                containerName: buildContainerName({ appId: c.appId, subdomain: newSubdomain, image: c.image }),
                image: c.image,
                tag: c.tag,
                // From the binding (privos.mcp.image.digest), not c.imageDigest
                // (the generic privos.image.digest label) — both are set from the
                // same value at container-create time, but the binding is the
                // single value this same recovery call also puts into the new
                // container's mcpV3Binding label, so there is exactly one source
                // of truth for what image the restored container actually runs.
                digest: mcpV3PreviousBinding.imageDigest,
                workspaceId: c.workspaceId ?? undefined,
                listingId: c.listingId ?? undefined,
                versionDigest: c.versionDigest ?? undefined,
                port: c.port,
                resources: c.resources,
                envVars: swapEnvVars,
                mounts,
                subdomain: newSubdomain,
                baseDomain,
                createdAt: c.createdAt,
                mcp: { ...mcpContext, binding: mcpV3PreviousBinding },
            });
            logger.warn({ containerId }, 'redeploy failed — previous image restored, upgrade rolled back');
            refreshRoutes();
            (err as Error & { recovered?: boolean }).recovered = true;
        } catch (restoreErr: any) {
            logger.error(
                { containerId, err: restoreErr.message },
                'redeploy failed AND restoring the previous image also failed — operator attention required',
            );
            (err as Error & { recovered?: boolean }).recovered = false;
        }
        throw err;
    }
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
    // MCP v3's broker binding is a single named socket per replica, torn down
    // and recreated by mcpBrokerManager.register() — safe for a stop-then-create
    // swap (the old container is already gone by the time the new one
    // registers), unsafe for a rolling overlap (it would sever the still-serving
    // old container's private channel mid-flight). redeployContainerSmart never
    // selects this path for an MCP v3 upgrade; this guard is defense in depth
    // for any other caller of this exported function.
    if (req.mcpV3Binding) throw new Error('mcp_v3_rolling_redeploy_unsupported');

    const old = await getContainerOr404(containerId, workspaceId);
    await assertRawRedeployAllowed(old.dockerContainerId);

    if (old.state !== 'running') {
        throw new Error(`Cannot rolling-redeploy a non-running container (state=${old.state}) — start it first`);
    }

    // A caller supplying a NEW digest is deliberately moving off the digest the
    // container currently runs, so fall back to the repository rather than the
    // running pinned reference — otherwise the pull refuses its own disagreeing
    // pin and the redeploy fails before anything is touched.
    const newImage = req.image ?? (req.digest ? imageRepositoryOf(old.image) : old.image);
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
 * Which of the two swap primitives a redeploy will actually use. Exported and
 * pure so the decision is independently testable without Docker: rolling
 * requires the caller to want it, the container to already be running, no
 * persistent Docker volumes (two writers → corruption), and — an MCP v3
 * broker binding is a single named socket per replica, a resource
 * `old.volumes` cannot see (it is a bind mount, not a Docker named volume),
 * which is why it is disqualified explicitly here rather than being caught
 * incidentally by the volume check. See rollingRedeployContainer's comment.
 */
export function selectRedeploySwapStrategy(
    old: Pick<Container, 'volumes' | 'state'>,
    req: Pick<RedeployRequest, 'rolling' | 'mcpV3Binding'>,
): 'ROLLING' | 'STOP_THEN_CREATE' {
    const wantRolling = req.rolling !== false;
    const eligible = wantRolling && old.volumes.length === 0 && old.state === 'running' && !req.mcpV3Binding;
    return eligible ? 'ROLLING' : 'STOP_THEN_CREATE';
}

/**
 * Prefer zero-downtime rolling; fall back to stop-then-create when rolling is
 * unsafe/inapplicable (see selectRedeploySwapStrategy). On a rolling failure
 * the error propagates — no silent downtime fallback. The chosen strategy is
 * returned alongside the result rather than left for a caller to re-derive:
 * this is the only layer that knows why rolling was or wasn't used.
 */
export async function redeployContainerSmart(
    containerId: string,
    req: RedeployRequest,
    workspaceId?: string,
): Promise<{ container: Container; swapStrategy: 'ROLLING' | 'STOP_THEN_CREATE' }> {
    const old = await getContainerOr404(containerId, workspaceId);
    const swapStrategy = selectRedeploySwapStrategy(old, req);

    if (swapStrategy === 'ROLLING') {
        return { container: await rollingRedeployContainer(containerId, req, workspaceId), swapStrategy };
    }

    if (req.rolling !== false && !req.mcpV3Binding) {
        const reason =
            old.volumes.length > 0 ? `has ${old.volumes.length} persistent volume(s)` : `not running (state=${old.state})`;
        logger.info({ containerId, reason }, 'rolling unavailable, using stop-then-create redeploy');
    }
    return { container: await redeployContainer(containerId, req, workspaceId), swapStrategy };
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
