import Docker from 'dockerode';
import { config } from '../config.js';
import { getAppNetworkName } from '../services/settings-service.js';

/**
 * Docker rejects network.connect for containers that share the host or another
 * container's network namespace. The production fleet agent intentionally uses
 * host networking so its loopback native proxy can reach every workspace bridge
 * by container IP; attaching that agent is both unnecessary and invalid.
 */
export function canAttachAgentToWorkspaceNetwork(networkMode: string | undefined): boolean {
    return networkMode !== 'host' && !networkMode?.startsWith('container:');
}

/**
 * Matches only per-workspace app networks (`privos-ws-<workspaceId>-apps`).
 * Everything else on the node — product stacks, canary composes, the shared
 * non-fleet network — is out of the garbage collector's reach by construction.
 */
export const WORKSPACE_APP_NETWORK_PATTERN = /^privos-ws-.+-apps$/;

export class NetworkManager {
    constructor(private docker: Docker) {}

    async ensureNetwork(workspaceId?: string): Promise<void> {
        if (config.FLEET_MODE && !workspaceId) return;
        const networkName = getAppNetworkName(workspaceId);
        try {
            await this.docker.createNetwork({
                Name: networkName,
                Driver: 'bridge',
                CheckDuplicate: true,
            });
        } catch (err: any) {
            if (err.statusCode !== 409) {
                throw new Error(`Failed to create network ${networkName}: ${err.message}`);
            }
        }

        if (!config.FLEET_MODE) return;
        const agentInfo = await this.docker.getContainer(config.FLEET_AGENT_CONTAINER).inspect();
        if (!canAttachAgentToWorkspaceNetwork(agentInfo.HostConfig?.NetworkMode)) return;

        const network = this.docker.getNetwork(networkName);
        const info = await network.inspect();
        const connected = Object.values(info.Containers ?? {}).some(
            (container: any) => container.Name === config.FLEET_AGENT_CONTAINER,
        );
        if (!connected) {
            try {
                await network.connect({ Container: config.FLEET_AGENT_CONTAINER });
            } catch (err: any) {
                if (err.statusCode !== 403 && !String(err.message).includes('already exists')) {
                    throw new Error(
                        `Failed to attach ${config.FLEET_AGENT_CONTAINER} to ${networkName}: ${err.message}`,
                    );
                }
            }
        }
    }

    /**
     * Make a stopped container's workspace network usable again. If the network is gone
     * (it was removed while the container was stopped) it is recreated, and a container
     * whose endpoint points at an older incarnation of the network is detached and
     * attached again — Docker refuses to start it otherwise ("network <id> not found").
     * Returns true when anything had to be repaired.
     */
    async repairContainerNetwork(
        dockerContainerId: string,
        networkName: string,
        workspaceId: string,
        endpointNetworkId: string | undefined,
    ): Promise<boolean> {
        let repaired = false;
        const inspectNetwork = async (): Promise<any | null> => {
            try {
                return await this.docker.getNetwork(networkName).inspect();
            } catch (err: any) {
                if (err.statusCode === 404) return null;
                throw err;
            }
        };
        let info = await inspectNetwork();
        if (!info) {
            await this.ensureNetwork(workspaceId);
            info = await inspectNetwork();
            if (!info) throw new Error(`network ${networkName} could not be recreated`);
            repaired = true;
        }
        if (endpointNetworkId !== info.Id) {
            const network = this.docker.getNetwork(networkName);
            await network.disconnect({ Container: dockerContainerId, Force: true }).catch(() => undefined);
            await network.connect({ Container: dockerContainerId });
            repaired = true;
        }
        return repaired;
    }

    /**
     * Remove one workspace's app network when nothing runs in it anymore.
     *
     * Docker's default address pools hold ~31 bridge subnets, and every
     * workspace network left behind by an uninstalled or purged workspace
     * permanently consumes one — a fleet node that never removes them
     * eventually cannot create ANY network ("all predefined address pools
     * have been fully subnetted") and every new install on the node fails.
     * The next deploy recreates the network on demand (ensureNetwork), so
     * removing an empty one is always safe; Docker itself refuses the removal
     * if a container attached concurrently, which is treated as "kept".
     */
    async removeWorkspaceNetworkIfUnused(workspaceId: string): Promise<boolean> {
        if (!config.FLEET_MODE) return false;
        const networkName = getAppNetworkName(workspaceId);
        if (!WORKSPACE_APP_NETWORK_PATTERN.test(networkName)) return false;
        const network = this.docker.getNetwork(networkName);
        let info: any;
        try {
            info = await network.inspect();
        } catch (err: any) {
            if (err.statusCode === 404) return false;
            throw err;
        }
        // Docker lists only RUNNING containers under a network. A stopped managed
        // container still references it through NetworkMode and needs it back at
        // its next start (e.g. after a host reboot), so it keeps the network alive.
        const referencing = await this.docker.listContainers({
            all: true,
            filters: { label: ['privos.managed=true'] },
        });
        if (referencing.some((container: any) => container.HostConfig?.NetworkMode === networkName)) return false;
        const attached = Object.values(info.Containers ?? {}) as Array<{ Name?: string }>;
        const nonAgent = attached.filter((container) => container.Name !== config.FLEET_AGENT_CONTAINER);
        if (nonAgent.length > 0) return false;
        // The agent attaches itself at ensure time (non-host networking only);
        // it must let go before the network can be removed.
        if (attached.length > nonAgent.length) {
            await network.disconnect({ Container: config.FLEET_AGENT_CONTAINER, Force: true }).catch(() => undefined);
        }
        try {
            await network.remove();
            return true;
        } catch (err: any) {
            // 404 = already gone; 403/409/500-in-use = a container attached in
            // the meantime — the network is in use again, exactly what "unused"
            // removal must yield to.
            if (err.statusCode === 404) return false;
            return false;
        }
    }

    /**
     * Sweep every workspace app network that has no containers and is older
     * than `minAgeMs`. The age guard keeps the sweeper from racing a deploy
     * that just created its network but has not attached the container yet.
     * Returns the removed network names for the caller's log line.
     */
    async sweepUnusedWorkspaceNetworks(minAgeMs: number): Promise<string[]> {
        if (!config.FLEET_MODE) return [];
        const networks = await this.docker.listNetworks();
        const removed: string[] = [];
        const cutoff = Date.now() - minAgeMs;
        for (const summary of networks) {
            const name = summary.Name ?? '';
            if (!WORKSPACE_APP_NETWORK_PATTERN.test(name)) continue;
            const createdAt = summary.Created ? Date.parse(summary.Created) : NaN;
            if (!Number.isNaN(createdAt) && createdAt > cutoff) continue;
            const workspaceId = name.slice('privos-ws-'.length, -'-apps'.length);
            if (await this.removeWorkspaceNetworkIfUnused(workspaceId)) removed.push(name);
        }
        return removed;
    }
}
