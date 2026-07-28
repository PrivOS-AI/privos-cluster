import Docker from 'dockerode';
import { getAppNetworkName } from '../services/settings-service.js';

export class NetworkManager {
    constructor(private docker: Docker) {}

    async ensureNetwork(): Promise<void> {
        const networkName = getAppNetworkName();
        try {
            await this.docker.createNetwork({
                Name: networkName,
                Driver: 'bridge',
                CheckDuplicate: true,
            });
        } catch (err: any) {
            if (err.statusCode === 409) return; // already exists — idempotent
            throw new Error(`Failed to create network ${networkName}: ${err.message}`);
        }
    }
}
