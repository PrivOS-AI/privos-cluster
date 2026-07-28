import Docker from 'dockerode';
import { config } from '../config.js';
import { getAppNetworkName } from '../services/settings-service.js';

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
}
