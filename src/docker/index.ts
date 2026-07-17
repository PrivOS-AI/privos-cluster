import Docker from 'dockerode';
import { config } from '../config.js';
import { ContainerManager } from './container-manager.js';
import { ImageManager } from './image-manager.js';
import { NetworkManager } from './network-manager.js';
import * as containersRepo from '../db/containers-repo.js';
import * as imagesRepo from '../db/images-repo.js';
import type { Image } from '../types/index.js';

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

export async function reconcileState(): Promise<void> {
    // On startup, sync DB ↔ Docker:
    // - For each managed container in DB, check if Docker still has it
    // - If Docker container gone → mark DB row as 'error'
    // - If Docker state differs from DB state → update DB
    const dbContainers = containersRepo.findAll();
    const dockerList = await containerManager.listMcpContainers();
    const dockerMap = new Map(dockerList.map((c) => [c.Id, c]));

    for (const dbRow of dbContainers) {
        const dockerContainer = dockerMap.get(dbRow.dockerContainerId);
        if (!dockerContainer) {
            // Container gone from Docker
            if (dbRow.state !== 'error') {
                containersRepo.updateState(dbRow.id, 'error');
            }
            continue;
        }
        // Map Docker state → our state enum
        const dockerState = dockerContainer.State;
        const mappedState =
            dockerState === 'running' ? 'running'
            : dockerState === 'created' ? 'created'
            : 'stopped';
        if (dbRow.state !== mappedState) {
            containersRepo.updateState(dbRow.id, mappedState);
        }
    }
}

/**
 * Sync the images table with the Docker daemon.
 *
 * The cluster only manages images it OWNS — i.e. images that entered via this
 * cluster (pulled / built / explicitly registered by a user through the UI).
 * It does NOT auto-import every image present on the Docker host, so unrelated
 * local images won't clutter the UI.
 *
 * On each pass:
 * - Drop DB rows that were only auto-discovered (registered with no user) —
 *   leftover from older behavior. This untracks them WITHOUT deleting the
 *   underlying Docker image.
 * - Drop ghost rows whose Docker image no longer exists.
 * - Refresh metadata (size, digest, id, labels) for owned images still present.
 */
export async function reconcileImages(): Promise<void> {
    const live = await imageManager.list();
    const liveByRepoTag = new Map(live.map((img) => [`${img.repository}:${img.tag}`, img]));
    const now = Date.now();

    for (const dbImg of imagesRepo.findAll()) {
        // "Owned" = pulled or built by the cluster, or registered by a real user.
        // Auto-discovered rows (source 'registered' with builtBy null) are untracked.
        const isClusterOwned =
            dbImg.source === 'pulled' ||
            dbImg.source === 'built' ||
            (dbImg.source === 'registered' && dbImg.builtBy != null);

        if (!isClusterOwned) {
            imagesRepo.deleteById(dbImg.id); // untrack only — Docker image is left intact
            continue;
        }

        const liveImg = liveByRepoTag.get(`${dbImg.repository}:${dbImg.tag}`);
        if (!liveImg) {
            imagesRepo.deleteById(dbImg.id); // ghost — image gone from the daemon
            continue;
        }

        // Refresh live metadata that may have drifted.
        const next: Image = {
            ...dbImg,
            dockerImageId: liveImg.dockerImageId,
            digest: liveImg.digest,
            sizeBytes: liveImg.sizeBytes,
            labels: liveImg.labels,
            updatedAt: now,
        };
        imagesRepo.upsertByRepoTag(next);
    }
}
