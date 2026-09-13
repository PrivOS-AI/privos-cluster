/**
 * Local-runtime artifact store — TS port of
 * `infra/local-runtime-driver/privos_local_runtime_driver/docker_api.py:249-323`'s
 * `load_image`/`_verified_loaded_reference` plus the phase-6 `stage` op the
 * Python driver never had (there, `artifact.path` is a persistent shared-fs
 * path re-opened on every ABI call; here the tunnel only ever hands the
 * artifact bytes to the process once, as an ephemeral temp file — see
 * `tunnel-client.ts`'s `ArtifactStoreFn` seam). `stage()` is the ONLY place
 * that ever reads the temp file; by the time it returns, the caller deletes
 * the file, so everything this store needs to answer later ENSURE_READY /
 * STATUS / ACTIVATE / REMOVE calls (`resolve()`) is durably recorded here
 * — never re-derived from `artifact.path`, matching the phase requirement
 * that `artifact.path` in ENSURE_READY is echoed but never opened.
 *
 * OCI-layout verification is `oci-archive.ts`. This module adds: the
 * ≥3x free-space preflight, the `docker load` call, content-address proof
 * (graphdriver `Id` / containerd `Descriptor` exact match), the 0600
 * persisted staged-artifact index (digest -> proven image reference) that
 * makes staging idempotent by digest with at most one `docker load`, and the
 * 250 MB ceiling.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type Docker from 'dockerode';

import { ArtifactError, ArtifactStagingRefused } from './errors.js';
import { type VerifiedOciArchive, verifyOciArchive } from './oci-archive.js';
import type { ImageManager } from '../docker/image-manager.js';

const OCI_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const INDEX_FILENAME = 'staged-artifacts.json';

export interface StagedArtifactRecord {
	digest: string;
	sizeBytes: number;
	manifestDigest: string;
	manifestSizeBytes: number;
	configDigest: string;
	/** The Docker-verified content address the runtime container is created against — `configDigest` or `manifestDigest`. */
	imageRef: string;
	stagedAt: number;
}

/** The subset of Docker behaviour the artifact store needs — kept narrow and injectable so tests never require a live daemon. */
export interface ArtifactStoreDocker {
	/** Loads an OCI-layout tar from disk into the Docker image store. */
	loadArchive(filePath: string): Promise<void>;
	/** Inspects an image by content address; `null` on 404 (not present). */
	inspectImage(reference: string): Promise<{ Id: string; Descriptor?: { mediaType: string; digest: string; size: number } } | null>;
	/** Removes an image by content address. A 404 is success — the goal is absence, not a deletion event. */
	removeImage(reference: string): Promise<void>;
}

/** Production adapter over the existing `docker/index.ts` singletons — `imageManager.loadFromStream` for load, raw `docker.getImage(...).inspect()` for content-address proof (dockerode's typed `ImageInspectInfo` doesn't model the containerd `Descriptor` field). */
export function createDockerArtifactStoreDocker(docker: Docker, imageManager: ImageManager): ArtifactStoreDocker {
	return {
		async loadArchive(filePath: string): Promise<void> {
			const stream = fs.createReadStream(filePath);
			await imageManager.loadFromStream(stream);
		},
		async inspectImage(reference: string) {
			try {
				const info = await docker.getImage(reference).inspect();
				return info as unknown as { Id: string; Descriptor?: { mediaType: string; digest: string; size: number } };
			} catch (err: any) {
				if (err?.statusCode === 404) return null;
				throw new ArtifactError(`docker image inspection failed: ${err?.message ?? String(err)}`);
			}
		},
		async removeImage(reference: string): Promise<void> {
			try {
				await docker.getImage(reference).remove({ force: false, noprune: false });
			} catch (err: any) {
				if (err?.statusCode === 404) return;
				// 409 = a container still references the image. The runtime must be
				// removed before its artifact; surfacing this is what stops an
				// uninstall from reporting erasure while the image is still in use.
				throw new ArtifactError(`docker image removal failed: ${err?.message ?? String(err)}`);
			}
		},
	};
}

interface StagedArtifactIndex {
	schemaVersion: 1;
	byDigest: Record<string, StagedArtifactRecord>;
}

function emptyIndex(): StagedArtifactIndex {
	return { schemaVersion: 1, byDigest: {} };
}

export class ArtifactStore {
	private readonly indexPath: string;

	constructor(
		private readonly stateDir: string,
		private readonly docker: ArtifactStoreDocker,
		private readonly maxArtifactBytes = 250_000_000,
		private readonly freeSpaceMultiplier = 3,
		private readonly clock: () => number = Date.now,
	) {
		fs.mkdirSync(stateDir, { recursive: true, mode: DIR_MODE });
		fs.chmodSync(stateDir, DIR_MODE);
		this.indexPath = path.join(stateDir, INDEX_FILENAME);
		if (!fs.existsSync(this.indexPath)) this.writeIndex(emptyIndex());
		fs.chmodSync(this.indexPath, FILE_MODE);
	}

	/** Looks up an already-staged artifact by digest — never touches Docker or the filesystem beyond this one JSON index. */
	resolve(digest: string): StagedArtifactRecord | null {
		return this.readIndex().byDigest[digest] ?? null;
	}

	private readIndex(): StagedArtifactIndex {
		try {
			const raw = fs.readFileSync(this.indexPath, 'utf8');
			const parsed = JSON.parse(raw) as StagedArtifactIndex;
			if (parsed.schemaVersion !== 1 || typeof parsed.byDigest !== 'object') throw new Error('corrupt');
			return parsed;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex();
			return emptyIndex();
		}
	}

	private writeIndex(index: StagedArtifactIndex): void {
		const tmpPath = `${this.indexPath}.${process.pid}.${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify(index), { mode: FILE_MODE });
		fs.chmodSync(tmpPath, FILE_MODE);
		fs.renameSync(tmpPath, this.indexPath);
	}

	/**
	 * Free-space preflight: refuses BEFORE the (potentially expensive) OCI
	 * verification + `docker load` if fewer than `freeSpaceMultiplier`x the
	 * declared size is available in the state dir's filesystem — covers the
	 * temp file already on disk, the re-materialized tar `docker load`
	 * streams, and the unpacked image layers, coexisting in the worst case.
	 */
	private assertFreeSpace(sizeBytes: number): void {
		const needed = sizeBytes * this.freeSpaceMultiplier;
		let stats: fs.StatsFs;
		try {
			stats = fs.statfsSync(this.stateDir);
		} catch (err) {
			throw new ArtifactStagingRefused(`unable to determine free disk space: ${(err as Error).message}`);
		}
		const freeBytes = stats.bavail * stats.bsize;
		if (freeBytes < needed) {
			throw new ArtifactStagingRefused(
				`insufficient free space to stage a ${sizeBytes}-byte artifact: need >= ${needed} bytes (${this.freeSpaceMultiplier}x), have ${freeBytes}`,
			);
		}
	}

	/**
	 * Stages one artifact from a landed temp-file path. Idempotent by digest:
	 * a repeat call for a digest already recorded in the index returns the
	 * same record with zero further Docker calls; a repeat call after the
	 * index was lost (but Docker already has the image) still performs at
	 * most zero `docker load` calls, via the content-address pre-check.
	 */
	async stage(input: { path: string; sha256: string; sizeBytes: number }): Promise<StagedArtifactRecord> {
		if (input.sizeBytes > this.maxArtifactBytes) {
			throw new ArtifactStagingRefused(`artifact size ${input.sizeBytes} exceeds the ${this.maxArtifactBytes}-byte ceiling`);
		}
		this.assertFreeSpace(input.sizeBytes);
		const verified = await verifyOciArchive(input.path, input.sha256, input.sizeBytes, this.maxArtifactBytes);

		const existing = this.resolve(verified.artifactDigest);
		if (existing) return existing;

		const imageRef = await this.loadAndProveContentAddress(input.path, verified);
		const record: StagedArtifactRecord = {
			digest: verified.artifactDigest,
			sizeBytes: verified.sizeBytes,
			manifestDigest: verified.manifestDigest,
			manifestSizeBytes: verified.manifestSizeBytes,
			configDigest: verified.configDigest,
			imageRef,
			stagedAt: this.now(),
		};
		const index = this.readIndex();
		index.byDigest[record.digest] = record;
		this.writeIndex(index);
		return record;
	}

	/**
	 * Erases one staged artifact: the Docker image it was loaded into, then its
	 * index entry. Idempotent — a digest this store never held (or already
	 * removed) reports ABSENT with `removed: false` rather than failing, so an
	 * uninstall that retries, or one for an install that never got this far,
	 * still converges.
	 *
	 * Absence is PROVEN, not assumed: the image is re-inspected after removal and
	 * the index entry is dropped only once Docker confirms it is gone. A running
	 * container pinning the image makes `removeImage` throw (409) — correct, the
	 * runtime must be removed before its artifact, and erasure must never be
	 * reported while the bytes are still on the machine.
	 */
	async remove(digest: string): Promise<{ digest: string; state: 'ABSENT'; removed: boolean; checkedAt: number }> {
		const record = this.resolve(digest);
		if (!record) return { digest, state: 'ABSENT', removed: false, checkedAt: this.now() };

		await this.docker.removeImage(record.imageRef);
		if (await this.docker.inspectImage(record.imageRef)) {
			throw new ArtifactError('Docker still exposes the staged image after removal');
		}
		const index = this.readIndex();
		delete index.byDigest[digest];
		this.writeIndex(index);
		if (this.resolve(digest)) throw new ArtifactError('the staged-artifact record survived removal');
		return { digest, state: 'ABSENT', removed: true, checkedAt: this.now() };
	}

	private now(): number {
		const now = this.clock();
		if (!(now > 0)) throw new ArtifactError('the driver clock is invalid');
		return now;
	}

	private async loadAndProveContentAddress(filePath: string, verified: VerifiedOciArchive): Promise<string> {
		const already = await this.docker.inspectImage(verified.configDigest);
		if (already?.Id === verified.configDigest) return verified.configDigest;
		await this.docker.loadArchive(filePath);
		return this.proveContentAddress(verified);
	}

	/** Content-address pinning per the phase spec: graphdriver `inspect(configDigest).Id === configDigest`, else containerd `inspect(manifestDigest).Descriptor.{mediaType,digest,size}` exact. Never `repo@sha256:` and never a registry contact. */
	private async proveContentAddress(verified: VerifiedOciArchive): Promise<string> {
		const graphdriver = await this.docker.inspectImage(verified.configDigest);
		if (graphdriver?.Id === verified.configDigest) return verified.configDigest;

		const containerd = await this.docker.inspectImage(verified.manifestDigest);
		const descriptor = containerd?.Descriptor;
		if (
			descriptor &&
			descriptor.mediaType === OCI_MANIFEST_MEDIA_TYPE &&
			descriptor.digest === verified.manifestDigest &&
			descriptor.size === verified.manifestSizeBytes
		) {
			return verified.manifestDigest;
		}
		throw new ArtifactError('Docker did not expose the exact verified OCI image identity after load');
	}
}
