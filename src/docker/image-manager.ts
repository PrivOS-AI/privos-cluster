import Docker from 'dockerode';
import { Readable } from 'stream';

/**
 * Progress event emitted by Docker during a pull. Shape mirrors Docker's
 * JSON stream — fields are all optional because layers emit different keys
 * at different stages (download, extract, verify, etc.).
 */
export interface PullProgressEvent {
	id?: string;
	status?: string;
	progress?: string;
	progressDetail?: { current?: number; total?: number };
	error?: string;
}

export interface InspectedImage {
	dockerImageId: string;
	repoTag: string;        // "repository:tag" — primary
	repository: string;
	tag: string;
	digest: string | null;
	sizeBytes: number;
	labels: Record<string, string>;
	created: number;        // unix ms
}

export class ImageManager {
	constructor(private docker: Docker) {}

	/**
	 * List all images known to the daemon. `dangling` filter returns only
	 * untagged leftovers (good for prune UX).
	 */
	async list(opts: { dangling?: boolean } = {}): Promise<InspectedImage[]> {
		const filters: Record<string, string[]> = {};
		if (opts.dangling) filters.dangling = ['true'];
		const raw = await this.docker.listImages({ filters });
		const out: InspectedImage[] = [];
		for (const img of raw) {
			const repoTags = img.RepoTags ?? [];
			const repoDigests = img.RepoDigests ?? [];
			const digest = repoDigests[0]?.split('@')[1] ?? null;
			// Dangling images have no RepoTags → emit a single entry with <none>:<none>
			const tags = repoTags.length > 0 ? repoTags : ['<none>:<none>'];
			for (const repoTag of tags) {
				const [repository, tag] = splitRepoTag(repoTag);
				out.push({
					dockerImageId: img.Id,
					repoTag,
					repository,
					tag,
					digest,
					sizeBytes: img.Size ?? 0,
					labels: (img.Labels ?? {}) as Record<string, string>,
					created: (img.Created ?? 0) * 1000,
				});
			}
		}
		return out;
	}

	/**
	 * Look at the image's Config.ExposedPorts to guess a sensible port for
	 * a quick-run. Returns the lowest tcp port found, or null if the image
	 * doesn't declare any EXPOSE.
	 */
	async getExposedPort(repoTagOrId: string): Promise<number | null> {
		try {
			const info = await this.docker.getImage(repoTagOrId).inspect();
			const exposed = info.Config?.ExposedPorts ?? {};
			const tcpPorts = Object.keys(exposed)
				.filter((k) => k.endsWith('/tcp'))
				.map((k) => parseInt(k.split('/')[0], 10))
				.filter((n) => Number.isFinite(n) && n > 0)
				.sort((a, b) => a - b);
			return tcpPorts[0] ?? null;
		} catch {
			return null;
		}
	}

	async inspect(repoTagOrId: string): Promise<InspectedImage | null> {
		try {
			const info = await this.docker.getImage(repoTagOrId).inspect();
			const repoTag = info.RepoTags?.[0] ?? repoTagOrId;
			const [repository, tag] = splitRepoTag(repoTag);
			const digest = info.RepoDigests?.[0]?.split('@')[1] ?? null;
			return {
				dockerImageId: info.Id,
				repoTag,
				repository,
				tag,
				digest,
				sizeBytes: info.Size ?? 0,
				labels: (info.Config?.Labels ?? {}) as Record<string, string>,
				created: info.Created ? new Date(info.Created).getTime() : Date.now(),
			};
		} catch (err: any) {
			if (err.statusCode === 404) return null;
			throw err;
		}
	}

	/**
	 * Pull an image. Emits progress events to `onProgress`. Resolves with the
	 * inspected image once the pull completes successfully.
	 */
	async pull(
		repository: string,
		tag: string,
		onProgress: (ev: PullProgressEvent) => void = () => {},
		signal?: AbortSignal,
	): Promise<InspectedImage> {
		const repoTag = `${repository}:${tag}`;
		if (signal?.aborted) throw new Error('Pull cancelled');

		let stream: NodeJS.ReadableStream;
		try {
			stream = (await this.docker.pull(repoTag)) as NodeJS.ReadableStream;
		} catch (err: any) {
			if (err.statusCode === 404 || err.message?.includes('not found')) {
				throw new Error(`Image not found in registry: ${repoTag}`);
			}
			throw new Error(`Failed to start pull ${repoTag}: ${err.message}`);
		}

		// Tear down the upstream Docker stream if the caller aborts (client disconnect).
		// Docker daemon notices the HTTP request was closed and stops pulling.
		// Already-downloaded layers stay in the content-addressed cache for next time.
		const onAbort = () => {
			(stream as Readable).destroy?.(new Error('Pull cancelled by client'));
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		}

		try {
			await new Promise<void>((resolve, reject) => {
				this.docker.modem.followProgress(
					stream,
					(err: Error | null) => {
						if (signal?.aborted) reject(new Error('Pull cancelled'));
						else if (err) reject(new Error(`Pull failed for ${repoTag}: ${err.message}`));
						else resolve();
					},
					(ev: PullProgressEvent) => {
						onProgress(ev);
					},
				);
			});
		} finally {
			signal?.removeEventListener('abort', onAbort);
		}

		if (signal?.aborted) throw new Error('Pull cancelled');

		const inspected = await this.inspect(repoTag);
		if (!inspected) throw new Error(`Pulled image ${repoTag} not found after pull`);
		return inspected;
	}

	/**
	 * Load images from a tarball stream (output of `docker save`).
	 * Returns the repo:tags loaded by parsing the progress event "Loaded image: <repoTag>".
	 */
	async loadFromStream(
		input: NodeJS.ReadableStream,
		onProgress: (ev: { stream?: string; error?: string }) => void = () => {},
	): Promise<string[]> {
		const docker = this.docker as unknown as {
			loadImage: (file: NodeJS.ReadableStream) => Promise<NodeJS.ReadableStream>;
			modem: { followProgress: typeof Docker.prototype.modem.followProgress };
		};

		let outStream: NodeJS.ReadableStream;
		try {
			outStream = await docker.loadImage(input);
		} catch (err: any) {
			throw new Error(`docker load failed to start: ${err.message}`);
		}

		const loaded: string[] = [];
		await new Promise<void>((resolve, reject) => {
			docker.modem.followProgress(
				outStream as Readable,
				(err: Error | null) => {
					if (err) reject(new Error(`docker load failed: ${err.message}`));
					else resolve();
				},
				(ev: { stream?: string; error?: string }) => {
					onProgress(ev);
					if (ev.error) return;
					// "Loaded image: nginx:latest\n" or "Loaded image ID: sha256:..."
					const m = /Loaded image(?: ID)?:\s*(\S+)/.exec(ev.stream ?? '');
					if (m && m[1] && !m[1].startsWith('sha256:')) {
						loaded.push(m[1]);
					}
				},
			);
		});

		return loaded;
	}

	/**
	 * Apply an additional tag to an existing image. Idempotent at the Docker
	 * level — calling with an existing tag is a no-op.
	 */
	async tag(sourceRepoTagOrId: string, targetRepo: string, targetTag: string): Promise<void> {
		const image = this.docker.getImage(sourceRepoTagOrId);
		try {
			await image.tag({ repo: targetRepo, tag: targetTag });
		} catch (err: any) {
			throw new Error(`Failed to tag ${sourceRepoTagOrId} as ${targetRepo}:${targetTag}: ${err.message}`);
		}
	}

	/**
	 * Remove an image by repo:tag or ID. `force` removes even if in use by a
	 * stopped container. Returns false if the image was already gone (404).
	 */
	async remove(repoTagOrId: string, force = false): Promise<boolean> {
		try {
			await this.docker.getImage(repoTagOrId).remove({ force });
			return true;
		} catch (err: any) {
			if (err.statusCode === 404) return false;
			if (err.statusCode === 409) {
				throw new Error(`Image ${repoTagOrId} is in use by a container; pass force=true to override`);
			}
			throw new Error(`Failed to remove image ${repoTagOrId}: ${err.message}`);
		}
	}

	/**
	 * Prune dangling images. Returns the number of images deleted and total
	 * bytes reclaimed.
	 */
	async prune(): Promise<{ deleted: number; reclaimedBytes: number }> {
		const result = await this.docker.pruneImages({ filters: { dangling: { true: true } } as any });
		return {
			deleted: result.ImagesDeleted?.length ?? 0,
			reclaimedBytes: result.SpaceReclaimed ?? 0,
		};
	}
}

/**
 * Split "repo:tag" — including registry prefixes like "ghcr.io/org/repo:tag"
 * and digest references like "repo@sha256:...". Falls back to <none>:<none>.
 */
export function splitRepoTag(repoTag: string): [string, string] {
	if (!repoTag || repoTag === '<none>:<none>') return ['<none>', '<none>'];
	// digest reference
	if (repoTag.includes('@')) {
		const [repo] = repoTag.split('@');
		return [repo, '<none>'];
	}
	// last colon separates tag from possibly-port-containing repo
	const idx = repoTag.lastIndexOf(':');
	if (idx === -1) return [repoTag, 'latest'];
	const repo = repoTag.slice(0, idx);
	const tag = repoTag.slice(idx + 1);
	// guard: "host:5000/repo" has no tag — treat as latest
	if (tag.includes('/')) return [repoTag, 'latest'];
	return [repo, tag];
}
