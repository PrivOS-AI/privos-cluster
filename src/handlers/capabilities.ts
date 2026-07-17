import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

const PROTOCOL_VERSION = '1.0';
const CLUSTER_TYPE = 'docker';

interface ClusterCapabilities {
    service: string;
    version: string;
    protocol: string;
    type: 'docker' | 'k8s' | 'swarm' | 'custom';
    features: {
        deploy: boolean;
        start: boolean;
        stop: boolean;
        restart: boolean;
        redeploy: boolean;
        delete: boolean;
        logs: boolean;
        files: boolean;
        terminal: boolean;
        stats: boolean;
        volumes: boolean;
        rolling: boolean;
        secrets: boolean;
        replicas: boolean;
        adopt: boolean;
    };
    limits: {
        maxContainers: number;
        maxMemoryMb: number;
        maxCpus: number;
    };
}

const CAPABILITIES: ClusterCapabilities = {
    service: 'privos-cluster',
    version: '0.1.0',
    protocol: PROTOCOL_VERSION,
    type: CLUSTER_TYPE,
    features: {
        deploy: true,
        start: true,
        stop: true,
        restart: true,
        redeploy: true,
        delete: true,
        logs: true,
        files: true,
        terminal: true,
        stats: true,
        volumes: true,
        rolling: true,
        secrets: false,    // future
        replicas: false,   // future
        adopt: true,
    },
    limits: {
        maxContainers: 100,
        maxMemoryMb: 8192,
        maxCpus: 4,
    },
};

const capabilitiesHandler: FastifyPluginAsync = async (fastify) => {
    fastify.get('/api/v1/capabilities', async () => CAPABILITIES);
};

export default fp(capabilitiesHandler, { name: 'capabilities' });
