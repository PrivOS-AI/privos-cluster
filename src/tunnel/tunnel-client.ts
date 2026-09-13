/**
 * Dial-out tunnel client: the App Cluster's only outbound connection to the
 * Hub in tunnel mode. Opens one WebSocket to
 * `wss://<hub>/api/v1/app-clusters.tunnel`, replays unary `req` frames into
 * this process's own Fastify instance via `fastify.inject()` (so auth,
 * validation and Docker behaviour stay byte-identical to the HTTP path), and
 * streams `req-chunk` artifact-staging frames straight to a temp file —
 * never through `inject`, never buffered in memory.
 *
 * Socket creation and the artifact-store call are both injectable so unit
 * tests exercise the frame/dispatch/backoff/cap logic against fakes; no test
 * opens a real network socket.
 */
import { createHash, type Hash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// `FastifyInstance['inject']` resolves to an unusable overload union when
// indexed this way (its method-literal set doesn't even match itself across
// overloads); importing the underlying light-my-request types directly is
// the stable, documented shape fastify.inject actually accepts/returns.
import type { InjectOptions, Response as InjectResponse } from 'light-my-request';
import WebSocket from 'ws';

import { config } from '../config.js';
import { resolveClusterSecret } from '../cluster-secret.js';
import { docker } from '../docker/index.js';
import { getArtifactStore } from '../handlers/local-runtime.js';
import { areOperatorRoutesEnabled } from '../services/settings-service.js';
import { CLUSTER_ID_FILENAME, CREDENTIAL_FILENAME, PAIR_TOKEN_FILENAME, deleteStateFile, readStateFile, writeStateFile } from '../state-dir.js';
import { signConnectToken } from './connect-token.js';
import { dispatchForward, type ForwardRequest, type ForwardResponse } from './forward.js';
import { handleRepairRequiredClose, readBootstrapTokenFromEnv, runCommunityBootstrap } from './pairing.js';
import {
	FrameDecodeError,
	MAX_CHUNK_BYTES,
	MAX_STAGED_ARTIFACT_BYTES,
	decodeFrame,
	encodeFrame,
	type Frame,
	type PairedFrame,
	type ForwardFrame,
	type ReqChunkFrame,
	type ReqFrame,
	type ResFrame,
} from './frames.js';

const TUNNEL_PATH = '/api/v1/app-clusters.tunnel';
const WS_OPEN = 1;

export const DEFAULT_CONCURRENCY_LIMIT = 8;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 30_000;

/** Full-jitter exponential backoff, 1s -> 30s, forever (wire-contracts.md, tunnel reconnect rule). */
export function fullJitterBackoffMs(attempt: number, random: () => number = Math.random): number {
	const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
	return Math.floor(random() * exp);
}

// ---------------------------------------------------------------------------
// Staging seam: never buffers a staged artifact in memory — it writes chunks
// straight to a temp file with a rolling sha256 and, once the stream
// completes, calls this function with the finished file's path.
//
// This is REQUIRED, deliberately. It used to default to a no-op placeholder
// from before the artifact store existed, and production never overrode it:
// the Hub streamed the whole artifact over the tunnel, the chunks landed in a
// temp file, the no-op resolved, the caller deleted the file, and the bytes
// were gone — while the cluster still advertised `artifactStaging: true`. The
// Hub therefore believed staging succeeded and only found out at `ensureReady`
// (409 ARTIFACT_NOT_STAGED). Requiring it makes that silent drop a compile
// error instead of a runtime mystery.
// ---------------------------------------------------------------------------
export interface StagedArtifact {
	path: string;
	sha256: string;
	sizeBytes: number;
}
export type ArtifactStoreFn = (artifact: StagedArtifact) => Promise<void>;

// ---------------------------------------------------------------------------
// Phase-6 seam: `forward` (MCP RPC dispatch to a running local-runtime app
// container). Injectable the same way `artifactStore` is, so tests never
// touch Docker; the production default wires the real label-scoped dispatch
// (`forward.ts`) against this process's own `docker` singleton.
// ---------------------------------------------------------------------------
export type ForwardDispatchFn = (input: ForwardRequest) => Promise<ForwardResponse>;
const defaultForwardDispatch: ForwardDispatchFn = (input) => dispatchForward(docker, input);

/** Minimal transport surface this module needs from a WebSocket — real `ws` and test fakes both satisfy it. */
export interface TunnelSocket {
	on(event: 'open', listener: () => void): void;
	on(event: 'message', listener: (data: Buffer | string, isBinary: boolean) => void): void;
	on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
	on(event: 'error', listener: (err: Error) => void): void;
	send(data: string | Buffer): void;
	close(code?: number, reason?: string): void;
	readonly readyState: number;
}

export interface TunnelLogger {
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

/** The subset of a Fastify instance the tunnel client dispatches unary requests against. */
export interface TunnelFastify {
	inject: (opts: InjectOptions) => Promise<InjectResponse>;
	log: TunnelLogger;
}

export interface TunnelClientOptions {
	hubUrl: string;
	clusterId: string;
	version: string;
	stateDir: string;
	clusterCapabilities: { operatorRoutes: boolean; artifactStaging: boolean };
	fastify: TunnelFastify;
	/** Resolves the secret used to sign the connect JWT; defaults to the real `resolveClusterSecret()`. */
	resolveSecret: () => string | undefined;
	concurrencyLimit?: number;
	/** Required: a missing store used to fall back to a no-op that silently discarded every staged artifact. */
	artifactStore: ArtifactStoreFn;
	forwardDispatch?: ForwardDispatchFn;
	/** Injectable for tests — the default opens a real `ws` connection. */
	createSocket?: (url: string, headers: Record<string, string>) => TunnelSocket;
	/** Injectable for deterministic backoff tests. */
	random?: () => number;
}

interface StageSession {
	tempPath: string;
	fd: number;
	hash: Hash;
	bytesWritten: number;
}

function toWsUrl(hubUrl: string): string {
	const url = new URL(hubUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = TUNNEL_PATH;
	url.search = '';
	return url.toString();
}

function defaultCreateSocket(url: string, headers: Record<string, string>): TunnelSocket {
	return new WebSocket(url, { headers }) as unknown as TunnelSocket;
}

function stagingDir(stateDir: string): string {
	return path.join(stateDir, 'staging');
}

function ensureStagingDir(stateDir: string): string {
	const dir = stagingDir(stateDir);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Deletes every leftover staged-artifact temp file. A partial transfer from a previous process run can never be resumed — called once at `TunnelClient.start()` (boot) and on every disconnect. */
export function cleanupStagingDir(stateDir: string): void {
	const dir = stagingDir(stateDir);
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw err;
	}
	for (const entry of entries) {
		try {
			fs.unlinkSync(path.join(dir, entry));
		} catch {
			// best effort — another cleanup pass or the OS may already have removed it
		}
	}
}

/** Maps a Hub-controlled req-chunk `id` to a safe, collision-resistant filename (never a path built from the raw id). */
function stageFilename(id: string): string {
	return `${createHash('sha256').update(id).digest('hex')}.part`;
}

export class TunnelClient {
	private readonly options: TunnelClientOptions & {
		concurrencyLimit: number;
		artifactStore: ArtifactStoreFn;
		forwardDispatch: ForwardDispatchFn;
		createSocket: (url: string, headers: Record<string, string>) => TunnelSocket;
		random: () => number;
	};

	private socket: TunnelSocket | undefined;
	private stopped = false;
	private reconnectAttempt = 0;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private inFlight = 0;
	private pendingChunk: ReqChunkFrame | undefined;
	private readonly stageSessions = new Map<string, StageSession>();
	private bootstrapInFlight = false;

	constructor(options: TunnelClientOptions) {
		this.options = {
			...options,
			concurrencyLimit: options.concurrencyLimit ?? DEFAULT_CONCURRENCY_LIMIT,
			artifactStore: options.artifactStore,
			forwardDispatch: options.forwardDispatch ?? defaultForwardDispatch,
			createSocket: options.createSocket ?? defaultCreateSocket,
			random: options.random ?? Math.random,
		};
	}

	/** Sweeps partial staged-artifact temp files left by a previous run, then opens the first connection. */
	start(): void {
		cleanupStagingDir(this.options.stateDir);
		this.connect();
	}

	/** Stops reconnecting and closes the current socket, if any. Idempotent. */
	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.cleanupAllStageSessions();
		this.socket?.close(1000, 'shutdown');
		this.socket = undefined;
	}

	/**
	 * The id to put in the connect JWT's `kid`. Once paired that MUST be the id the
	 * Hub assigned — it looks the cluster up by that id — and not the local
	 * `FLEET_CLUSTER_ID` default, which exists only for the fleet-side deployment
	 * where the operator names the cluster.
	 */
	private resolveClusterId(): string {
		return readStateFile(this.options.stateDir, CLUSTER_ID_FILENAME)?.trim() || this.options.clusterId;
	}

	private buildAuthHeaders(): Record<string, string> {
		const secret = this.options.resolveSecret();
		if (secret) {
			return { Authorization: `Bearer ${signConnectToken(this.resolveClusterId(), secret)}` };
		}
		// Not yet paired: fall back to the one-time pair token written by the
		// installer/CLI. If neither is available, connect anyway with no
		// credential — the Hub refuses it and the client just keeps retrying
		// with backoff ("dials and waits", not a crash-loop).
		const pairToken = readStateFile(this.options.stateDir, PAIR_TOKEN_FILENAME);
		if (pairToken?.trim()) return { 'X-Privos-Pair-Token': pairToken.trim() };
		return {};
	}

	/**
	 * Community bootstrap kickoff (`pairing.ts`): a no-op unless `PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN`
	 * is set and this process is neither paired nor already holding a pair token to redeem.
	 * Runs alongside the normal connect attempt (never blocks it — a fresh compose stack
	 * still dials and waits like any unpaired process) and, on success, writes the
	 * redeemed pair token to the state dir so the next connect attempt (this one, if still
	 * unpaired, or the following reconnect) redeems it through the same header-carried path.
	 */
	private maybeRunCommunityBootstrap(): void {
		if (this.bootstrapInFlight) return;
		if (this.options.resolveSecret()) return; // already paired
		if (readStateFile(this.options.stateDir, PAIR_TOKEN_FILENAME)?.trim()) return; // already have a token to redeem
		const bootstrapToken = readBootstrapTokenFromEnv();
		if (!bootstrapToken) return; // community bootstrap not configured — admin-initiated pairing only
		this.bootstrapInFlight = true;
		runCommunityBootstrap({ hubUrl: this.options.hubUrl, bootstrapToken, stateDir: this.options.stateDir })
			.then((result) => {
				if (!result.ok) {
					this.options.fastify.log.warn({ reason: result.reason }, 'tunnel: community bootstrap pairing failed');
					return;
				}
				this.options.fastify.log.info(
					{ clusterId: result.clusterId },
					'tunnel: community bootstrap pairing succeeded — pair token stored, redeeming on next connect',
				);
			})
			.catch((err) => this.options.fastify.log.warn({ err }, 'tunnel: community bootstrap pairing errored'))
			.finally(() => {
				this.bootstrapInFlight = false;
			});
	}

	private connect(): void {
		if (this.stopped) return;
		this.maybeRunCommunityBootstrap();
		const wsUrl = toWsUrl(this.options.hubUrl);
		const headers = this.buildAuthHeaders();
		this.options.fastify.log.info({ wsUrl }, 'tunnel: connecting');
		const socket = this.options.createSocket(wsUrl, headers);
		this.socket = socket;

		socket.on('open', () => {
			this.reconnectAttempt = 0;
			this.options.fastify.log.info('tunnel: connected');
			this.sendFrame({
				t: 'hello',
				version: this.options.version,
				// Same id as the connect JWT's `kid`: the Hub compares this frame against
				// the cluster it resolved from that `kid` and closes 4401 on a mismatch.
				clusterId: this.resolveClusterId(),
				clusterCapabilities: this.options.clusterCapabilities,
			});
		});
		socket.on('message', (data, isBinary) => this.handleMessage(data, isBinary));
		socket.on('close', (code, reason) => {
			this.options.fastify.log.info({ code, reason: reason?.toString() }, 'tunnel: disconnected');
			this.cleanupAllStageSessions();
			this.socket = undefined;
			const hasPairToken = Boolean(readStateFile(this.options.stateDir, PAIR_TOKEN_FILENAME)?.trim());
			const repairReason = handleRepairRequiredClose(this.options.stateDir, code, hasPairToken);
			if (repairReason) {
				this.options.fastify.log.warn(
					{ reason: repairReason },
					'tunnel: re-pair required — stored credential is dead, waiting for a new pair token (no restart needed)',
				);
			}
			this.scheduleReconnect();
		});
		socket.on('error', (err) => {
			this.options.fastify.log.warn({ err }, 'tunnel: socket error');
		});
	}

	private scheduleReconnect(): void {
		if (this.stopped) return;
		const delay = fullJitterBackoffMs(this.reconnectAttempt, this.options.random);
		this.reconnectAttempt++;
		this.options.fastify.log.info({ delayMs: delay, attempt: this.reconnectAttempt }, 'tunnel: reconnecting');
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
		this.reconnectTimer.unref?.();
	}

	private sendFrame(frame: Frame): void {
		if (!this.socket || this.socket.readyState !== WS_OPEN) return;
		try {
			this.socket.send(encodeFrame(frame));
		} catch (err) {
			this.options.fastify.log.error({ err }, 'tunnel: failed to encode/send frame');
		}
	}

	private handleMessage(data: Buffer | string, isBinary: boolean): void {
		if (this.pendingChunk) {
			const control = this.pendingChunk;
			this.pendingChunk = undefined;
			const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
			this.finishChunk(control, payload);
			return;
		}
		if (isBinary) {
			this.options.fastify.log.warn('tunnel: unexpected binary frame with no pending req-chunk control');
			return;
		}
		const text = typeof data === 'string' ? data : data.toString('utf8');
		let frame: Frame;
		try {
			frame = decodeFrame(text);
		} catch (err) {
			if (err instanceof FrameDecodeError) {
				this.options.fastify.log.warn({ reason: err.message }, 'tunnel: bad frame, closing socket 4400');
				this.socket?.close(err.closeCode, 'bad_frame');
				return;
			}
			throw err;
		}
		switch (frame.t) {
			case 'paired':
				this.handlePaired(frame);
				break;
			case 'ping':
				this.sendFrame({ t: 'pong', at: frame.at });
				break;
			case 'req':
				void this.handleReq(frame);
				break;
			case 'req-chunk':
				this.pendingChunk = frame;
				break;
			case 'forward':
				this.handleForward(frame);
				break;
			default:
				// 'hello', 'res', 'pong' are frames this side only ever sends.
				this.options.fastify.log.warn({ t: frame.t }, 'tunnel: unexpected frame direction, ignoring');
		}
	}

	private handlePaired(frame: PairedFrame): void {
		writeStateFile(this.options.stateDir, CREDENTIAL_FILENAME, frame.credential);
		// Persist the Hub-assigned id too: every later connect signs its `kid` with
		// it, and without it the client would keep presenting the local default and
		// be refused 401 forever after a successful pairing.
		writeStateFile(this.options.stateDir, CLUSTER_ID_FILENAME, frame.clusterId);
		deleteStateFile(this.options.stateDir, PAIR_TOKEN_FILENAME);
		this.options.fastify.log.info(
			{ clusterId: frame.clusterId },
			'tunnel: paired — credential persisted; hub will close this socket, reconnecting with the new credential',
		);
	}

	private async handleReq(frame: ReqFrame): Promise<void> {
		if (this.inFlight >= this.options.concurrencyLimit) {
			this.sendFrame({
				t: 'res',
				id: frame.id,
				status: 429,
				error: { code: 'too_many_requests', message: 'tunnel concurrency limit exceeded' },
			});
			return;
		}
		this.inFlight++;
		try {
			const query = frame.query ? `?${new URLSearchParams(frame.query).toString()}` : '';
			const injected = await this.options.fastify.inject({
				// method arrives from the Hub as a wire string; an invalid one
				// simply 404/405s through fastify's own routing, same as HTTP.
				method: frame.method.toUpperCase() as InjectOptions['method'],
				url: frame.path + query,
				headers: frame.headers,
				payload: (frame.raw ? frame.rawBody : frame.body) as InjectOptions['payload'],
			});
			const res: ResFrame = { t: 'res', id: frame.id, status: injected.statusCode };
			if (frame.raw) {
				res.raw = true;
				res.rawBody = injected.body;
			} else if (injected.body) {
				try {
					res.body = injected.json();
				} catch {
					res.raw = true;
					res.rawBody = injected.body;
				}
			}
			this.sendFrame(res);
		} catch (err) {
			this.options.fastify.log.error({ err, id: frame.id }, 'tunnel: req dispatch failed');
			this.sendFrame({ t: 'res', id: frame.id, status: 500, body: { error: 'internal_error' } });
		} finally {
			this.inFlight--;
		}
	}

	/**
	 * MCP RPC dispatch to a running app container (wire-contracts.md
	 * `forward`): resolves the target by its `privos.local-runtime.id` Docker
	 * label (phase 6, `forward.ts`) and proxies the request, answered with a
	 * correlated `res` frame.
	 */
	private handleForward(frame: ForwardFrame): void {
		void this.dispatchForwardFrame(frame);
	}

	private async dispatchForwardFrame(frame: ForwardFrame): Promise<void> {
		try {
			const result = await this.options.forwardDispatch({
				runtimeId: frame.runtimeId,
				path: frame.path,
				headers: frame.headers,
				body: frame.body,
				timeoutMs: frame.timeoutMs,
			});
			const res: ResFrame = { t: 'res', id: frame.id, status: result.status };
			if (result.headers) res.headers = result.headers;
			if (result.raw) {
				res.raw = true;
				res.rawBody = result.rawBody;
			} else if (result.body !== undefined) {
				res.body = result.body;
			}
			if (result.error) res.error = result.error;
			this.sendFrame(res);
		} catch (err) {
			this.options.fastify.log.error({ err, id: frame.id }, 'tunnel: forward dispatch failed');
			this.sendFrame({ t: 'res', id: frame.id, status: 500, body: { error: 'internal_error' } });
		}
	}

	private getOrCreateStageSession(id: string): StageSession {
		const existing = this.stageSessions.get(id);
		if (existing) return existing;
		const dir = ensureStagingDir(this.options.stateDir);
		const tempPath = path.join(dir, stageFilename(id));
		const fd = fs.openSync(tempPath, 'w', 0o600);
		const session: StageSession = { tempPath, fd, hash: createHash('sha256'), bytesWritten: 0 };
		this.stageSessions.set(id, session);
		return session;
	}

	private abortStageSession(id: string): void {
		const session = this.stageSessions.get(id);
		if (!session) return;
		try {
			fs.closeSync(session.fd);
		} catch {
			// already closed
		}
		try {
			fs.unlinkSync(session.tempPath);
		} catch {
			// already gone
		}
		this.stageSessions.delete(id);
	}

	private cleanupAllStageSessions(): void {
		for (const id of [...this.stageSessions.keys()]) this.abortStageSession(id);
	}

	/**
	 * `req-chunk` is handled entirely outside `fastify.inject` — the binary
	 * payload is written straight to a temp file with a rolling sha256, never
	 * materialized as a JS buffer of the whole artifact. Cap violations
	 * (oversized/mismatched chunk, or the running total exceeding the 250 MB
	 * ceiling) close the socket `4413` per the frozen wire contract, rather
	 * than answering with a `res` frame — there is no `res` semantics defined
	 * for a chunk-stream cap violation in wire-contracts.md, only the close code.
	 */
	private finishChunk(control: ReqChunkFrame, payload: Buffer): void {
		try {
			if (payload.byteLength !== control.byteLength || payload.byteLength > MAX_CHUNK_BYTES) {
				throw new Error(
					`chunk cap violation for '${control.id}': declared=${control.byteLength} received=${payload.byteLength} cap=${MAX_CHUNK_BYTES}`,
				);
			}
			const session = this.getOrCreateStageSession(control.id);
			if (session.bytesWritten + payload.byteLength > MAX_STAGED_ARTIFACT_BYTES) {
				throw new Error(`staged artifact '${control.id}' exceeds the ${MAX_STAGED_ARTIFACT_BYTES}-byte cap`);
			}
			fs.writeSync(session.fd, payload);
			session.hash.update(payload);
			session.bytesWritten += payload.byteLength;
			if (control.last) {
				const sha256 = session.hash.digest('hex');
				fs.closeSync(session.fd);
				this.stageSessions.delete(control.id);
				void this.finalizeStage(control.id, session.tempPath, sha256, session.bytesWritten);
			}
		} catch (err) {
			this.options.fastify.log.warn({ err, id: control.id }, 'tunnel: chunk cap violation, closing socket 4413');
			this.abortStageSession(control.id);
			this.socket?.close(4413, 'chunk_too_large');
		}
	}

	private async finalizeStage(id: string, tempPath: string, sha256: string, sizeBytes: number): Promise<void> {
		try {
			await this.options.artifactStore({ path: tempPath, sha256, sizeBytes });
		} catch (err) {
			this.options.fastify.log.error({ err, id }, 'tunnel: artifact-store call failed');
		} finally {
			try {
				fs.unlinkSync(tempPath);
			} catch {
				// already gone
			}
		}
	}
}

function readPackageVersion(): string {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		// dist/tunnel/tunnel-client.js -> package root is two levels up (same
		// depth as src/tunnel/tunnel-client.ts -> repo root).
		const pkgPath = path.join(here, '..', '..', 'package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
		return pkg.version;
	} catch {
		return '0.0.0';
	}
}

/** Production entry point: builds a `TunnelClient` from `config` and starts it. Called by `server.ts` only when tunnel mode is active. */
export function startTunnelClient(fastify: TunnelFastify): TunnelClient {
	if (!config.PRIVOS_HUB_URL) {
		throw new Error('startTunnelClient requires PRIVOS_HUB_URL to be set');
	}
	const client = new TunnelClient({
		hubUrl: config.PRIVOS_HUB_URL,
		clusterId: config.FLEET_CLUSTER_ID,
		version: readPackageVersion(),
		stateDir: config.PRIVOS_STATE_DIR,
		clusterCapabilities: { operatorRoutes: areOperatorRoutesEnabled(), artifactStaging: true },
		fastify,
		resolveSecret: resolveClusterSecret,
		// Without this the seam falls back to `defaultArtifactStore`, a no-op left
		// over from before the artifact store existed: the Hub streams the whole
		// artifact over the tunnel, the chunks land in a temp file, the no-op
		// resolves, the temp file is deleted — and the bytes are gone. The cluster
		// still advertises `artifactStaging: true`, so the Hub believes staging
		// happened and the next `ensureReady` fails ARTIFACT_NOT_STAGED. That is
		// every install onto a tunnel-connected cluster, which is every
		// self-hosted deployment.
		artifactStore: async ({ path: tempPath, sha256, sizeBytes }) => {
			await getArtifactStore().stage({ path: tempPath, sha256, sizeBytes });
		},
	});
	client.start();
	return client;
}
