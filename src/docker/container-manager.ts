import Docker from 'dockerode';
import { config } from '../config.js';
import type { ContainerResources } from '../types/index.js';

export interface CreateContainerConfig {
    appId: string;          // metadata label (mcp-app-id); not used for naming anymore
    containerName: string;  // explicit Docker container name (caller computes via buildContainerName)
    image: string;
    tag: string;
    port: number;
    resources: ContainerResources;
    envVars?: Record<string, string>;
    mounts?: Array<{ dockerVolumeName: string; mountPath: string }>;  // named volume mounts
    subdomain?: string | null;     // DNS label
    baseDomain?: string | null;    // e.g. 'apps.example.com' — combined with subdomain for Caddy
}

/**
 * Build the Docker label map for a container. Includes the cluster's own
 * labels (mcp-app, cluster-managed) plus, when a subdomain+baseDomain is set,
 * the caddy-docker-proxy labels that publish the container behind Caddy.
 *
 * caddy-docker-proxy reads these labels and reloads its config automatically;
 * we never need to talk to Caddy directly.
 */
export function buildContainerLabels(cfg: {
    appId: string;
    port: number;
    subdomain?: string | null;
    baseDomain?: string | null;
}): Record<string, string> {
    const labels: Record<string, string> = {
        'mcp-app': 'true',
        'mcp-app-id': cfg.appId,
        'cluster-managed': 'true',
    };
    if (cfg.subdomain && cfg.baseDomain) {
        const host = `${cfg.subdomain}.${cfg.baseDomain}`;
        labels.caddy = host;
        // `{{upstreams N}}` resolves to the container's network IP:N at runtime.
        labels['caddy.reverse_proxy'] = `{{upstreams ${cfg.port}}}`;
        labels['privos.subdomain'] = cfg.subdomain;
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
        onProgress?: (event: { status: string; progress?: string }) => void,
    ): Promise<void> {
        const repoTag = `${image}:${tag}`;

        // Check if image already exists locally
        try {
            await this.docker.getImage(repoTag).inspect();
            return; // found locally — skip pull
        } catch {
            // not found locally, proceed to pull
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

        const env = Object.entries(cfg.envVars || {}).map(([k, v]) => `${k}=${v}`);
        env.push(`PORT=${cfg.port}`);

        const portKey = `${cfg.port}/tcp`;

        const container = await this.docker.createContainer({
            Image: `${cfg.image}:${cfg.tag}`,
            name: containerName,
            Env: env,
            ExposedPorts: { [portKey]: {} },
            Labels: buildContainerLabels({
                appId: cfg.appId,
                port: cfg.port,
                subdomain: cfg.subdomain,
                baseDomain: cfg.baseDomain,
            }),
            HostConfig: {
                NetworkMode: config.DOCKER_NETWORK,
                ReadonlyRootfs: true,
                Tmpfs: { '/tmp': `size=${cfg.resources.tmpSizeMb}m,mode=1777` },
                CapDrop: ['ALL'],
                SecurityOpt: ['no-new-privileges:true'],
                Memory: cfg.resources.memoryMb * 1024 * 1024,
                MemorySwap: cfg.resources.memoryMb * 1024 * 1024, // disable swap
                NanoCpus: Math.round(cfg.resources.cpus * 1e9),
                PidsLimit: 100,
                PortBindings: {
                    [portKey]: [{ HostPort: '0' }], // auto-assign host port
                },
                RestartPolicy: { Name: 'no' }, // health monitor handles restarts
                Mounts: cfg.mounts?.map((m) => ({
                    Type: 'volume' as const,
                    Source: m.dockerVolumeName,
                    Target: m.mountPath,
                    ReadOnly: false,
                })) ?? [],
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
        networkName: string = config.DOCKER_NETWORK,
    ): Promise<string | null> {
        const info = await this.docker.getContainer(containerId).inspect();
        const networks = info.NetworkSettings?.Networks || {};
        return networks[networkName]?.IPAddress || null;
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
    async execCommand(containerId: string, cmd: string[]): Promise<string> {
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
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => {
                // TTY mode adds \r\n — strip carriage returns
                resolve(Buffer.concat(chunks).toString('utf-8').replace(/\r/g, ''));
            });
            stream.on('error', reject);
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
    async ensureVolume(name: string, _sizeMb?: number): Promise<void> {
        try {
            await this.docker.createVolume({
                Name: name,
                Labels: { 'mcp-app': 'true' },
            });
        } catch (err: any) {
            if (err.statusCode === 409) return; // already exists — idempotent
            throw new Error(`Failed to create volume ${name}: ${err.message}`);
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
}
