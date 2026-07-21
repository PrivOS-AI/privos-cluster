import Docker from 'dockerode';
import { config } from '../config.js';
import { ContainerManager } from './container-manager.js';
import { ImageManager } from './image-manager.js';
import { NetworkManager } from './network-manager.js';

// Auto-pick transport: Windows named pipe vs Unix socket vs explicit host.
// - If DOCKER_HOST env is set, dockerode reads it natively (TCP/SSH).
// - On Windows, override the default Linux socket path with the Docker Desktop named pipe.
function buildDockerOptions(): Docker.DockerOptions {
    if (process.env.DOCKER_HOST) return {};
    const socket = config.DOCKER_SOCKET;
    if (process.platform === 'win32' && socket.startsWith('/var/')) {
        return { socketPath: '//./pipe/docker_engine' };
    }
    return { socketPath: socket };
}

export const docker = new Docker(buildDockerOptions());

export const networkManager = new NetworkManager(docker);
export const containerManager = new ContainerManager(docker);
export const imageManager = new ImageManager(docker);
