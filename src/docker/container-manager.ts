import crypto from 'node:crypto';

import Docker from 'dockerode';

import { resolveImmutableImageReference } from './image-reference.js';
import { config } from '../config.js';
import type { ContainerResources, McpRuntimeBinding, McpRuntimeBindingV3 } from '../types/index.js';
import { getAppNetworkName } from '../services/settings-service.js';
import { buildMcpRuntimeResourceLabelsV3 } from '../security/mcp-resource-labels-v3.js';

export interface CreateContainerConfig {
    id: string;             // cluster-generated uuid — becomes the API container id (label privos.id)
    appId: string;          // metadata label (mcp-app-id); not used for naming anymore
    containerName: string;  // explicit Docker container name (caller computes via buildContainerName)
    image: string;
    tag: string;
    digest?: string;
    workspaceId?: string;
    listingId?: string;
    versionDigest?: string;
    port: number;
    resources: ContainerResources;
    envVars?: Record<string, string>;
    /** Platform-owned PRIVOS_* variables; they override any same-named entry. */
    platformEnvVars?: Record<string, string>;
    /** Names within envVars whose values must stay out of the Docker labels. */
    secretEnvKeys?: string[];
    mounts?: Array<{ dockerVolumeName: string; mountPath: string }>;  // named volume mounts
    subdomain?: string | null;     // DNS label
    baseDomain?: string | null;    // e.g. 'apps.example.com' — combined with subdomain for Caddy
    createdBy?: string | null;     // JWT sub of the deployer
    createdAt?: number;            // epoch ms (defaults to now)
    mcpBinding?: McpRuntimeBinding;
	mcpV3Binding?: McpRuntimeBindingV3;
    brokerMount?: { source: string; target: string };
}

// Default health policy encoded into labels so the (in-memory) health monitor can
// act on it — and self-heal — without any database.
export const HEALTH_DEFAULTS = { path: '/health', maxFails: 3, restart: true } as const;

// Sentinel for "no value" in a Docker label (labels can't be null/absent-typed cleanly).
const LABEL_NONE = '';

/** Key-sorted JSON so the env digest is stable across insertion orders. */
function canonicalEnvJson(env: Record<string, string>): string {
	return JSON.stringify(Object.keys(env).sort().map((key) => [key, env[key]]));
}

/**
 * Environment actually handed to the container process. Platform PRIVOS_*
 * variables always win: the operator map is refused that namespace upstream, so
 * a collision here can only be an attempt to shadow a platform value.
 */
export function resolveContainerEnv(cfg: {
	envVars?: Record<string, string>;
	platformEnvVars?: Record<string, string>;
}): Record<string, string> {
	return { ...(cfg.envVars ?? {}), ...(cfg.platformEnvVars ?? {}) };
}

/**
 * Build the Docker label map for a container. This is the FULL metadata schema:
 * Docker labels are the cluster's source of truth (no database), so every field
 * needed to reconstruct the API `Container` is written here at create time.
 * Also emits the caddy-docker-proxy labels when a subdomain+baseDomain is set.
 *
 * NOTE: labels are immutable after create — changing metadata means recreating
 * the container (already true for memory/port). Secrets/large env are NOT stored
 * in labels; env is read back from the container's Config.Env instead.
 */
export function buildContainerLabels(cfg: {
    id: string;
    appId: string;
    image: string;
    tag: string;
    digest?: string;
    workspaceId?: string;
    listingId?: string;
    versionDigest?: string;
    port: number;
    resources: ContainerResources;
    envVars?: Record<string, string>;
    secretEnvKeys?: string[];
    subdomain?: string | null;
    baseDomain?: string | null;
    createdBy?: string | null;
    createdAt?: number;
	mcpBinding?: McpRuntimeBinding;
	mcpV3Binding?: McpRuntimeBindingV3;
}): Record<string, string> {
	if (cfg.mcpBinding && cfg.mcpV3Binding) throw new Error('mcp_protocol_binding_conflict');
	const userEnv = cfg.envVars ?? {};
	const secretKeys = (cfg.secretEnvKeys ?? []).filter((key) => key in userEnv).sort();
	// Labels are world-readable to anyone who can run `docker inspect`. Operator
	// secrets are therefore recorded by NAME only; their values live solely in
	// the container's own Config.Env. The digest covers the full user env so
	// drift is still detectable without exposing anything.
	const labelledEnv = Object.fromEntries(
		Object.entries(userEnv).filter(([key]) => !secretKeys.includes(key)),
	);
    const labels: Record<string, string> = {
        // Legacy discovery labels (kept for backward compat with existing tooling).
        'mcp-app': 'true',
        'mcp-app-id': cfg.appId,
        'cluster-managed': 'true',
        // Stateless-agent schema — source of truth for the API.
        'privos.managed': 'true',
        'privos.id': cfg.id,
        'privos.app-id': cfg.appId || LABEL_NONE,
        'privos.image': cfg.image,
        'privos.tag': cfg.tag,
        'privos.image.digest': cfg.digest || LABEL_NONE,
        'privos.workspace': cfg.workspaceId || LABEL_NONE,
        'privos.listing': cfg.listingId || LABEL_NONE,
        'privos.version.digest': cfg.versionDigest || LABEL_NONE,
        'privos.port': String(cfg.port),
        'privos.resources': JSON.stringify(cfg.resources),
        // Only the USER-supplied, NON-SECRET env is recorded (matches the DB,
        // which stored req.envVars). Do NOT reconstruct env from Config.Env —
        // that also carries image-baked ENV (incl. any secrets) and PORT.
        'privos.env': JSON.stringify(labelledEnv),
        'privos.env.secret-keys': JSON.stringify(secretKeys),
        'privos.env.digest': crypto.createHash('sha256').update(canonicalEnvJson(userEnv)).digest('hex'),
        'privos.subdomain': cfg.subdomain || LABEL_NONE,
        'privos.domain': cfg.baseDomain || LABEL_NONE,
        'privos.created-by': cfg.createdBy || LABEL_NONE,
        'privos.created-at': new Date(cfg.createdAt ?? Date.now()).toISOString(),
        'privos.health.path': HEALTH_DEFAULTS.path,
        'privos.health.max-fails': String(HEALTH_DEFAULTS.maxFails),
        'privos.health.restart': String(HEALTH_DEFAULTS.restart),
    };
	if (cfg.mcpBinding) {
		Object.assign(labels, {
			'privos.mcp.schema': '2',
			'privos.mcp.cluster': cfg.mcpBinding.clusterId,
			'privos.mcp.node': cfg.mcpBinding.nodeId,
			'privos.mcp.installation': cfg.mcpBinding.installationId,
			'privos.mcp.app': cfg.mcpBinding.mcpAppId,
			'privos.mcp.replica': cfg.mcpBinding.replicaId,
			'privos.mcp.image.digest': cfg.mcpBinding.imageDigest,
			'privos.mcp.manifest.digest': cfg.mcpBinding.manifestDigest,
			'privos.mcp.receipt': cfg.mcpBinding.receiptHash,
			'privos.mcp.grant-epoch': String(cfg.mcpBinding.grantEpoch),
			'privos.mcp.deployment-grant-hash': cfg.mcpBinding.deploymentGrantHash,
			'privos.mcp.hub-origin': cfg.mcpBinding.hubOrigin,
			'privos.mcp.hub-kid': cfg.mcpBinding.hubKid,
			'privos.mcp.hub-jwk': JSON.stringify(cfg.mcpBinding.hubPublicJwk),
		});
	}
	if (cfg.mcpV3Binding) {
		Object.assign(labels, buildMcpRuntimeResourceLabelsV3(cfg.mcpV3Binding, {
			kind: 'CONTAINER',
			resourceId: cfg.id,
		}));
	}
    // V2 workloads are published only through the native path-aware proxy,
    // which blocks MCP/bootstrap/identity routes. Never let legacy Caddy label
    // discovery create an unfiltered second ingress.
    if (cfg.subdomain && cfg.baseDomain && !cfg.mcpBinding && !cfg.mcpV3Binding) {
        const host = `${cfg.subdomain}.${cfg.baseDomain}`;
        labels.caddy = host;
        // `{{upstreams N}}` resolves to the container's network IP:N at runtime.
        labels['caddy.reverse_proxy'] = `{{upstreams ${cfg.port}}}`;
        labels['privos.public-host'] = host;
    }
    return labels;
}

export class ContainerManager {
    constructor(private docker: Docker) {}

    /**
     * Check local image cache first; only pull from registry if not found.
     */
    async pullImage(
        image: string,
        tag = 'latest',
        digest?: string,
        onProgress?: (event: { status: string; progress?: string }) => void,
    ): Promise<void> {
        const repoTag = resolveImmutableImageReference(image, tag, digest);

        // Digest pulls always contact the registry. This prevents a locally retagged
        // image from satisfying a marketplace deploy.
        if (!digest) {
            try {
                await this.docker.getImage(repoTag).inspect();
                return;
            } catch {
                // not found locally, proceed to pull
            }
        }

        try {
            const stream = await this.docker.pull(repoTag);
            await new Promise<void>((resolve, reject) => {
                this.docker.modem.followProgress(
                    stream,
                    (err: any) => {
                        if (err) reject(new Error(`Failed to pull ${repoTag}: ${err.message}`));
                        else resolve();
                    },
                    onProgress,
                );
            });
        } catch (err: any) {
            if (err.statusCode === 404 || err.message?.includes('not found')) {
                throw new Error(`Image not found: ${repoTag}`);
            }
            throw new Error(`Failed to pull ${repoTag}: ${err.message}`);
        }
    }

    /**
     * Create a security-hardened container. Returns containerId, containerName, and hostPort=0
     * (hostPort must be resolved via getHostPort after the container is started).
     */
    async createAppContainer(
        cfg: CreateContainerConfig,
    ): Promise<{ containerId: string; containerName: string; hostPort: number }> {
        const containerName = cfg.containerName;

        const env = Object.entries(resolveContainerEnv(cfg)).map(([k, v]) => `${k}=${v}`);
        env.push(`PORT=${cfg.port}`);

        const portKey = `${cfg.port}/tcp`;

        const container = await this.docker.createContainer({
            Image: resolveImmutableImageReference(cfg.image, cfg.tag, cfg.digest),
            name: containerName,
            Env: env,
            ExposedPorts: { [portKey]: {} },
            Labels: buildContainerLabels({
                id: cfg.id,
                appId: cfg.appId,
                image: cfg.image,
                tag: cfg.tag,
                digest: cfg.digest,
                workspaceId: cfg.workspaceId,
                listingId: cfg.listingId,
                versionDigest: cfg.versionDigest,
                port: cfg.port,
                resources: cfg.resources,
                envVars: cfg.envVars,
                secretEnvKeys: cfg.secretEnvKeys,
                subdomain: cfg.subdomain,
                baseDomain: cfg.baseDomain,
                createdBy: cfg.createdBy,
                createdAt: cfg.createdAt,
				mcpBinding: cfg.mcpBinding,
				mcpV3Binding: cfg.mcpV3Binding,
            }),
            HostConfig: {
                NetworkMode: getAppNetworkName(cfg.workspaceId),
                ReadonlyRootfs: true,
                Tmpfs: { '/tmp': `size=${cfg.resources.tmpSizeMb}m,mode=1777` },
                CapDrop: ['ALL'],
                SecurityOpt: ['no-new-privileges:true'],
                Memory: cfg.resources.memoryMb * 1024 * 1024,
                MemorySwap: cfg.resources.memoryMb * 1024 * 1024, // disable swap
                NanoCpus: Math.round(cfg.resources.cpus * 1e9),
                // Fair CPU sharing under contention: NanoCpus alone is a hard cap, not a
                // weight, so every container competes equally for idle CPU regardless of
                // its own size package. CpuShares (1024 = one full share) makes an XL
                // package get proportionally more of a contended host than an S package.
                CpuShares: Math.round(1024 * cfg.resources.cpus),
                PidsLimit: 100,
                RestartPolicy: { Name: 'no' }, // health monitor handles restarts
				Mounts: [
					...(cfg.mounts?.map((m) => ({
						Type: 'volume' as const,
						Source: m.dockerVolumeName,
						Target: m.mountPath,
						ReadOnly: false,
					})) ?? []),
					...(cfg.brokerMount
						? [{
							Type: 'bind' as const,
							Source: cfg.brokerMount.source,
							Target: cfg.brokerMount.target,
							ReadOnly: true,
						}]
						: []),
				],
            },
        });

        const info = await container.inspect();
        return { containerId: info.Id, containerName, hostPort: 0 };
    }

    /**
     * Read the host-mapped port after a container has started.
     * Critical on macOS where Docker bridge IPs are not reachable from the host.
     */
    async getHostPort(containerId: string, containerPort: number): Promise<number> {
        const info = await this.docker.getContainer(containerId).inspect();
        const portKey = `${containerPort}/tcp`;
        const bindings = info.NetworkSettings?.Ports?.[portKey];
        if (bindings && bindings.length > 0 && bindings[0].HostPort) {
            return parseInt(bindings[0].HostPort, 10);
        }
        throw new Error(`No host port binding found for ${portKey}`);
    }

    async getContainerIp(
        containerId: string,
        networkName?: string,
    ): Promise<string | null> {
        const info = await this.docker.getContainer(containerId).inspect();
        const networks = info.NetworkSettings?.Networks || {};
        if (networkName) return networks[networkName]?.IPAddress || null;
        const preferred = Object.entries(networks).find(([name]) => name.startsWith('privos-ws-'));
        return preferred?.[1]?.IPAddress || Object.values(networks)[0]?.IPAddress || null;
    }

    async startContainer(containerId: string): Promise<void> {
        const container = this.docker.getContainer(containerId);
        try {
            await container.start();
        } catch (err: any) {
            if (err.statusCode === 304) return; // already running
            throw new Error(`Failed to start container ${containerId}: ${err.message}`);
        }
    }

    async stopContainer(containerId: string, timeout = 10): Promise<void> {
        const container = this.docker.getContainer(containerId);
        try {
            await container.stop({ t: timeout });
        } catch (err: any) {
            if (err.statusCode === 304) return; // already stopped
            if (err.statusCode === 404) return; // gone
            throw new Error(`Failed to stop container ${containerId}: ${err.message}`);
        }
    }

    async restartContainer(containerId: string): Promise<void> {
        const container = this.docker.getContainer(containerId);
        await container.restart({ t: 10 });
    }

    async removeContainer(containerId: string, force = false): Promise<void> {
        const container = this.docker.getContainer(containerId);
        try {
            await container.remove({ force });
        } catch (err: any) {
            if (err.statusCode === 404) return; // already gone
            throw new Error(`Failed to remove container ${containerId}: ${err.message}`);
        }
    }

    async getContainerStats(containerId: string): Promise<{
        cpuPercent: number;
        memoryUsageMb: number;
        memoryLimitMb: number;
        memoryPercent: number;
    }> {
        const container = this.docker.getContainer(containerId);
        const stats = await container.stats({ stream: false });

        const cpuDelta =
            stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta =
            stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        // Guard: precpu_stats is zero on first call — return 0% rather than NaN
        const cpuPercent =
            systemDelta > 0
                ? (cpuDelta / systemDelta) * (stats.cpu_stats.online_cpus || 1) * 100
                : 0;

        const memoryUsageMb = (stats.memory_stats.usage || 0) / (1024 * 1024);
        const memoryLimitMb = (stats.memory_stats.limit || 1) / (1024 * 1024);
        const memoryPercent = (memoryUsageMb / memoryLimitMb) * 100;

        return {
            cpuPercent: Math.round(cpuPercent * 100) / 100,
            memoryUsageMb: Math.round(memoryUsageMb * 100) / 100,
            memoryLimitMb: Math.round(memoryLimitMb * 100) / 100,
            memoryPercent: Math.round(memoryPercent * 100) / 100,
        };
    }

    async getContainerLogs(
        containerId: string,
        tail = 100,
        timestamps = true,
    ): Promise<string> {
        const container = this.docker.getContainer(containerId);
        const logs = await container.logs({
            stdout: true,
            stderr: true,
            tail,
            timestamps,
            follow: false,
        });
        return (logs as unknown as Buffer).toString('utf-8');
    }

    async inspectContainer(containerId: string) {
        return this.docker.getContainer(containerId).inspect();
    }

    async listMcpContainers() {
        return this.docker.listContainers({
            all: true,
            filters: { label: ['mcp-app=true'] },
        });
    }

    /**
     * List running Docker containers with optional filters.
     * Used by the discoverable endpoint to find adoptable containers.
     */
    async listContainers(filters?: Record<string, string[]>, all = false): Promise<any[]> {
        return this.docker.listContainers({ all, filters });
    }

    /**
     * Run a command non-interactively and return stdout as a string.
     * Uses TTY mode; strips carriage returns from output.
     */
    async execCommand(
        containerId: string,
        cmd: string[],
        opts: { timeoutMs?: number; maxBytes?: number } = {},
    ): Promise<string> {
        const timeoutMs = opts.timeoutMs ?? 30_000;
        const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
        const container = this.docker.getContainer(containerId);
        const exec = await container.exec({
            Cmd: cmd,
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
        });
        const stream = await exec.start({ hijack: true, stdin: false, Tty: true });

        return new Promise<string>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let total = 0;
            let settled = false;
            // Single exit path: a hung/oversized exec must not leak the hijacked
            // stream or keep collecting into an unbounded buffer.
            const finish = (err: Error | null, value?: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                stream.destroy();
                if (err) reject(err);
                else resolve(value ?? '');
            };
            const timer = setTimeout(
                () => finish(new Error(`execCommand timed out after ${timeoutMs}ms`)),
                timeoutMs,
            );
            stream.on('error', (err: Error) => finish(err));
            stream.on('data', (chunk: Buffer) => {
                total += chunk.length;
                if (total > maxBytes) {
                    finish(new Error(`execCommand output exceeded ${maxBytes} bytes`));
                    return;
                }
                chunks.push(chunk);
            });
            stream.on('end', () => {
                // TTY mode adds \r\n — strip carriage returns
                finish(null, Buffer.concat(chunks).toString('utf-8').replace(/\r/g, ''));
            });
        });
    }

    /**
     * Create an interactive exec session (for web terminal).
     * Caller must call exec.start() and manage streams.
     */
    async createExec(containerId: string, cmd: string[] = ['/bin/sh']): Promise<Docker.Exec> {
        const container = this.docker.getContainer(containerId);
        return container.exec({
            Cmd: cmd,
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
            Env: ['TERM=xterm-256color', 'COLUMNS=120', 'LINES=30'],
        });
    }

    /**
     * Ensure a named Docker volume exists. Swallows 409 if already exists.
     */
    async ensureVolume(
        name: string,
        _sizeMb?: number,
        labels: Record<string, string> = {},
    ): Promise<void> {
        try {
            await this.docker.createVolume({
                Name: name,
                Labels: { 'mcp-app': 'true', ...labels },
            });
        } catch (err: any) {
            if (err.statusCode === 409) return; // already exists — idempotent
            throw new Error(`Failed to create volume ${name}: ${err.message}`);
        }
    }

    /**
     * Inspect a named Docker volume; null when it does not exist.
     */
    async inspectVolume(name: string): Promise<{ Name: string; Labels?: Record<string, string> } | null> {
        try {
            return await this.docker.getVolume(name).inspect();
        } catch (err: any) {
            if (err.statusCode === 404) return null;
            throw new Error(`Failed to inspect volume ${name}: ${err.message}`);
        }
    }

    /**
     * Remove a named Docker volume. Swallows 404 if already gone.
     */
    async removeVolume(name: string): Promise<void> {
        try {
            await this.docker.getVolume(name).remove({ force: true });
        } catch (err: any) {
            if (err.statusCode === 404) return; // already gone
            throw new Error(`Failed to remove volume ${name}: ${err.message}`);
        }
    }

    /**
     * List all Docker volumes managed by this cluster (label mcp-app=true).
     */
    async listVolumes(): Promise<any[]> {
        const result = await this.docker.listVolumes({
            filters: { label: ['mcp-app=true'] },
        });
        return result.Volumes ?? [];
    }

    async getVolumeSizeBytes(name: string): Promise<number> {
        const usage = await this.docker.df();
        const volume = usage.Volumes?.find((item: any) => item.Name === name);
        return Math.max(0, Number(volume?.UsageData?.Size ?? 0));
    }
}
