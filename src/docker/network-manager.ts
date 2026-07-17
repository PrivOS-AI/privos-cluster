import Docker from 'dockerode';
import { config } from '../config.js';

export class NetworkManager {
    constructor(private docker: Docker) {}

    async ensureNetwork(): Promise<void> {
        try {
            await this.docker.createNetwork({
                Name: config.DOCKER_NETWORK,
                Driver: 'bridge',
                CheckDuplicate: true,
            });
        } catch (err: any) {
            if (err.statusCode === 409) return; // already exists — idempotent
            throw new Error(`Failed to create network ${config.DOCKER_NETWORK}: ${err.message}`);
        }
    }
}
