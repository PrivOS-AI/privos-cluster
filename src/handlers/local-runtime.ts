/**
 * The five `privos-local-runtime-driver-v1` ABI routes (phase 6 routes
 * table). Registered on the existing Fastify instance behind the existing
 * `fastify.authenticate` preHandler, so they are reachable both over the
 * tunnel (`fastify.inject`, phase 3/4) and — on a fleet/master HTTP
 * deployment — over real HTTP.
 *
 * `stage` is the one op that, in tunnel mode, never actually reaches this
 * route: `tunnel-client.ts`'s `req-chunk` handling calls `ArtifactStore.stage`
 * directly on the landed temp file, bypassing `fastify.inject` entirely
 * (wire-contracts.md, "streamed staging, never buffered"). The route below
 * still exists and works standalone for a real HTTP PUT (the fleet/master
 * path), streaming the request body straight to a temp file itself.
 *
 * Every JSON body on these routes is parsed with `strictJsonParse`
 * (duplicate-member rejection) instead of Fastify's default `JSON.parse` —
 * scoped to this plugin only via `addContentTypeParser`, so no other
 * handler's parsing changes.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

import { strictJsonParse } from '../local-runtime/canonical.js';
import { ArtifactStore, createDockerArtifactStoreDocker } from '../local-runtime/artifact-store.js';
import { RuntimeLedger } from '../local-runtime/ledger.js';
import { RuntimeService } from '../local-runtime/runtime-service.js';
import { DriverError } from '../local-runtime/errors.js';
import { config } from '../config.js';
import { docker, imageManager } from '../docker/index.js';

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const PRIVATE_NETWORK = 'privos-local-runtime';
const PIDS_LIMIT = 128;
const READY_TIMEOUT_SECONDS = 30;

function stateSubDir(name: string): string {
	return path.join(config.PRIVOS_STATE_DIR, name);
}

let cachedArtifactStore: ArtifactStore | undefined;
let cachedRuntimeService: RuntimeService | undefined;

/**
 * Lazily built so importing this module never touches the filesystem/Docker (unit tests import the plugin without a state dir).
 *
 * Exported because the tunnel transport stages artifacts too: a tunnel-mode
 * `stage` never reaches the HTTP route below, so `tunnel-client.ts` must hand
 * its streamed bytes to THIS cached instance — the same one `RuntimeService`
 * later resolves digests against. A second store would stage into a different
 * directory and every `ensureReady` would still report ARTIFACT_NOT_STAGED.
 */
export function getArtifactStore(): ArtifactStore {
	if (!cachedArtifactStore) {
		cachedArtifactStore = new ArtifactStore(
			stateSubDir('artifacts'),
			createDockerArtifactStoreDocker(docker, imageManager),
			config.CLUSTER_LOCAL_RUNTIME_MAX_ARTIFACT_BYTES,
			config.CLUSTER_LOCAL_RUNTIME_FREE_SPACE_MULTIPLIER,
		);
	}
	return cachedArtifactStore;
}

function getRuntimeService(): RuntimeService {
	if (!cachedRuntimeService) {
		cachedRuntimeService = new RuntimeService(
			docker,
			new RuntimeLedger(path.join(stateSubDir('local-runtime'), 'runtimes.json')),
			getArtifactStore(),
			{ privateNetwork: PRIVATE_NETWORK, pidsLimit: PIDS_LIMIT, readyTimeoutSeconds: READY_TIMEOUT_SECONDS },
		);
	}
	return cachedRuntimeService;
}

function mapErrorToResponse(err: unknown): { status: number; body: { error: { code: string; message: string } } } {
	if (err instanceof DriverError) {
		return { status: err.status, body: { error: { code: err.code, message: err.message } } };
	}
	return { status: 500, body: { error: { code: 'internal_error', message: (err as Error)?.message ?? 'unexpected error' } } };
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
	const mapped = mapErrorToResponse(err);
	return reply.status(mapped.status).send(mapped.body);
}

function ensureStagingDir(): string {
	const dir = stateSubDir('http-stage');
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Streams a raw PUT body straight to a temp file with a rolling sha256, enforcing the artifact ceiling as bytes arrive — never buffers the whole body. */
async function streamBodyToTempFile(
	stream: NodeJS.ReadableStream,
	maxBytes: number,
): Promise<{ tempPath: string; sha256: string; sizeBytes: number }> {
	const dir = ensureStagingDir();
	const tempPath = path.join(dir, `${randomBytes(8).toString('hex')}.part`);
	const fd = fs.openSync(tempPath, 'w', 0o600);
	const hash = createHash('sha256');
	let total = 0;
	try {
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			total += chunk.length;
			if (total > maxBytes) {
				throw new Error(`request body exceeds the ${maxBytes}-byte local-runtime artifact ceiling`);
			}
			fs.writeSync(fd, chunk);
			hash.update(chunk);
		}
	} catch (err) {
		fs.closeSync(fd);
		fs.rmSync(tempPath, { force: true });
		throw err;
	}
	fs.closeSync(fd);
	return { tempPath, sha256: `sha256:${hash.digest('hex')}`, sizeBytes: total };
}

const localRuntimeHandler: FastifyPluginAsync = async (fastify) => {
	await fastify.register(async (scoped) => {
		// Duplicate-JSON-member rejection (fail-closed layer 1) — scoped to
		// this plugin only, so no other route's body parsing changes.
		scoped.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
			try {
				done(null, strictJsonParse(body as string));
			} catch (err) {
				done(err as Error, undefined);
			}
		});
		// The `stage` PUT body is raw tar bytes, not JSON — stream it to a temp
		// file ourselves instead of buffering it as the request body.
		scoped.addContentTypeParser(
			['application/octet-stream', 'application/x-tar', 'application/vnd.oci.image.layout.v1.tar'],
			(req, payload, done) => {
				streamBodyToTempFile(payload, config.CLUSTER_LOCAL_RUNTIME_MAX_ARTIFACT_BYTES)
					.then((result) => done(null, result))
					.catch((err) => done(err as Error, undefined));
			},
		);

		scoped.put<{ Params: { digest: string }; Body: { tempPath: string; sha256: string; sizeBytes: number } }>(
			'/api/v1/v3/local-artifacts/:digest',
			{ preHandler: scoped.authenticate },
			async (req, reply) => {
				const { digest } = req.params;
				if (!SHA256_RE.test(digest)) {
					return reply.status(400).send({ error: { code: 'bad_request', message: 'invalid artifact digest in path' } });
				}
				const landed = req.body;
				if (!landed || typeof landed !== 'object' || !('tempPath' in landed)) {
					return reply.status(400).send({ error: { code: 'bad_request', message: 'expected a streamed artifact body' } });
				}
				try {
					if (landed.sha256 !== digest) {
						throw Object.assign(new Error('staged artifact digest does not match the :digest path parameter'), {
							code: 'LOCAL_ARTIFACT_INVALID',
							status: 422,
						});
					}
					const staged = await getArtifactStore().stage({ path: landed.tempPath, sha256: landed.sha256, sizeBytes: landed.sizeBytes });
					return reply.send({ digest: staged.digest, sizeBytes: staged.sizeBytes, imageRef: staged.imageRef });
				} catch (err) {
					return sendError(reply, err);
				} finally {
					fs.rmSync(landed.tempPath, { force: true });
				}
			},
		);

		scoped.put<{ Params: { generationId: string }; Body: unknown }>(
			'/api/v1/v3/runtimes/by-generation/:generationId',
			{ preHandler: scoped.authenticate },
			async (req, reply) => {
				const body = req.body as Record<string, unknown> | null;
				if (!body || typeof body !== 'object' || body.generation_id !== req.params.generationId) {
					return reply.status(422).send({ error: { code: 'ENSURE_READY_INVALID', message: 'generation_id path parameter does not match the request body' } });
				}
				try {
					const ready = await getRuntimeService().ensureReady(body);
					return reply.send(ready);
				} catch (err) {
					return sendError(reply, err);
				}
			},
		);

		scoped.get<{ Params: { runtimeId: string } }>(
			'/api/v1/v3/runtimes/:runtimeId',
			{ preHandler: scoped.authenticate },
			async (req, reply) => {
				try {
					const ready = await getRuntimeService().status(req.params.runtimeId);
					return reply.send(ready);
				} catch (err) {
					return sendError(reply, err);
				}
			},
		);

		scoped.put<{ Params: { runtimeId: string }; Body: unknown }>(
			'/api/v1/v3/runtimes/:runtimeId/activation',
			{ preHandler: scoped.authenticate },
			async (req, reply) => {
				const body = req.body as Record<string, unknown> | null;
				if (!body || typeof body !== 'object' || body.runtime_id !== req.params.runtimeId) {
					return reply.status(422).send({ error: { code: 'ENSURE_READY_INVALID', message: 'runtimeId path parameter does not match the request body' } });
				}
				try {
					const active = await getRuntimeService().activate(body);
					return reply.send(active);
				} catch (err) {
					return sendError(reply, err);
				}
			},
		);

		// Artifact erasure, the destructive half of the local-artifact lifecycle.
		// Separate from runtime REMOVE on purpose: one artifact can back several
		// generations, so it is erased only when its own resource is purged.
		scoped.delete<{ Params: { digest: string } }>(
			'/api/v1/v3/local-artifacts/:digest',
			{ preHandler: scoped.authenticate },
			async (req, reply) => {
				const { digest } = req.params;
				if (!SHA256_RE.test(digest)) {
					return reply.status(400).send({ error: { code: 'bad_request', message: 'invalid artifact digest in path' } });
				}
				try {
					return reply.send(await getArtifactStore().remove(digest));
				} catch (err) {
					return sendError(reply, err);
				}
			},
		);

		scoped.delete<{ Params: { runtimeId: string }; Body: unknown }>(
			'/api/v1/v3/runtimes/:runtimeId',
			{ preHandler: scoped.authenticate },
			async (req, reply) => {
				const body = req.body as Record<string, unknown> | null;
				if (!body || typeof body !== 'object' || body.runtime_id !== req.params.runtimeId) {
					return reply.status(422).send({ error: { code: 'ENSURE_READY_INVALID', message: 'runtimeId path parameter does not match the request body' } });
				}
				try {
					const absent = await getRuntimeService().remove(body);
					return reply.send(absent);
				} catch (err) {
					return sendError(reply, err);
				}
			},
		);
	});
};

export default fp(localRuntimeHandler, { name: 'local-runtime-handler' });

/** Exposed for tests that need to reset the module-level singletons between state dirs. */
export function resetLocalRuntimeSingletonsForTests(): void {
	cachedArtifactStore = undefined;
	cachedRuntimeService = undefined;
}
