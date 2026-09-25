/**
 * Mesh-facing runtime listener (`RUNTIME`/`BOTH` role). Binds
 * `MESH_BIND_IP:RUNTIME_PROXY_PORT` and is reachable only from ingress nodes
 * (a ufw/INPUT allowlist on `wg0` — not DOCKER-USER, since the agent runs
 * `network_mode: host`). Because that OS-level allowlist is the only network
 * gate, this process trusts nothing about "who dialed in": every request must
 * carry a valid Ed25519 signature targeting THIS node before anything else
 * is even parsed.
 *
 * Host → appId comes from the runtime host table (phase 3, already
 * committed); the container is then resolved by its own `privos.app-id` +
 * `privos.workspace` + `privos.mcp.schema=3` labels — never by the table's
 * `containerId` string directly, so a stale table entry can never point at
 * the wrong (or a plain/v2) Docker container.
 *
 * PHASE-NOTE: the committed phase-3 runtime table carries one container per
 * app host, with no per-path port map yet (that is future work — see D7 in
 * the plan). `resolveTarget` below still runs the canonical path through a
 * real longest-prefix matcher (`canonical-path.ts`) against a single `/`
 * route bound to the container's own `privos.port` label, so adding real
 * per-path routes later is a data change, not a routing-logic change.
 *
 * PHASE-NOTE: `targetNodeId` in the signed payload is this node's WireGuard
 * mesh IP, not a `FLEET_NODE_ID` — the phase-3 ingress table's `nodes` field
 * carries mesh IPs only (no node-id ↔ meshIp directory exists yet), and a
 * mesh IP already uniquely and verifiably identifies "the destination the
 * ingress node chose" for the replay/target check below.
 */
import http from 'node:http';
import net from 'node:net';
import { request } from 'undici';
import pino from 'pino';
import { config } from '../config.js';
import { canonicalizePath, matchLongestPrefix, type PathRoute } from './canonical-path.js';
import { verifyRequest, type SignedRequestFields } from './forward-signature.js';
import type { ReplayCache } from './replay-cache.js';
import { createReplayCache } from './replay-cache.js';
import { stripPrivosLinkCookieDomains } from './cookie-domain-strip.js';
import { findRuntimeAppByHost, findSigningKey, type RuntimeApp, type SigningKey } from './host-table.js';
import * as dockerState from '../docker/docker-state.js';
import { containerManager } from '../docker/index.js';
import type { Container } from '../types/index.js';

const logger = pino({ level: config.LOG_LEVEL }).child({ component: 'runtime-listener' });

const SIGNATURE_TS_SKEW_MS = 30_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const SHUTDOWN_DRAIN_MS = 5_000;

// MCP surfaces are always private for a v3 container — never exposed publicly,
// on plain HTTP or an upgrade. Mirrors reverse-proxy-server.ts's v2 block list.
const BLOCKED_MCP_PATH =
	/^(?:\/mcp(?:\/|$)|\/bootstrap(?:\/|$)|\/identity(?:\/|$)|\/\.well-known\/privos\/(?:bootstrap|identity)(?:\/|$)|\/api\/v1\/mcp-workload(?:\/|$))/i;

const HOP_BY_HOP = new Set([
	'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
	'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);
// Used only for a WebSocket upgrade forwarded to the container: 'connection'/
// 'upgrade' must reach the container's raw socket write verbatim or the
// handshake can never complete — this is hand-written HTTP, not handed to
// undici, so nothing else regenerates them. 'host' is still explicitly
// re-added below either way.
const UPGRADE_HOP_BY_HOP = new Set(['keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'host']);
const RESP_HOP_BY_HOP = new Set([
	'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
	'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export interface RuntimeListenerDeps {
	/** This node's own mesh IP — must equal the signed `targetNodeId`. */
	selfMeshIp: string;
	findAppByHost: (host: string) => RuntimeApp | undefined;
	findSigningKeyByKid: (kid: string) => SigningKey | undefined;
	findContainerByAppId: (appId: string, workspaceId: string) => Promise<Container | null>;
	getContainerIp: (dockerContainerId: string) => Promise<string | null>;
	replayCache: ReplayCache;
	now?: () => number;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

interface ParsedSignatureHeaders {
	targetNodeId: string;
	nonce: string;
	ts: number;
	kid: string;
	clientIp: string;
	signature: string;
}

function readSignatureHeaders(req: http.IncomingMessage): ParsedSignatureHeaders | null {
	const h = req.headers;
	const targetNodeId = firstHeader(h['x-privos-target-node']);
	const nonce = firstHeader(h['x-privos-nonce']);
	const tsRaw = firstHeader(h['x-privos-ts']);
	const kid = firstHeader(h['x-privos-kid']);
	const clientIp = firstHeader(h['x-privos-client-ip']);
	const signature = firstHeader(h['x-privos-sig']);
	if (!targetNodeId || !nonce || !tsRaw || !kid || !clientIp || !signature) return null;
	const ts = Number(tsRaw);
	if (!Number.isFinite(ts)) return null;
	return { targetNodeId, nonce, ts, kid, clientIp, signature };
}

type AuthResult = { ok: true; clientIp: string } | { ok: false; status: number; code: string };

/**
 * Verifies the Ed25519 signature and the freshness/replay/target checks.
 * `method`/`host`/`requestTarget` are recomputed from the LIVE request (see
 * `forward-signature.ts`), so tampering with any of them in transit fails
 * verification on its own — only the fields below travel as headers.
 */
export function authenticateRuntimeRequest(deps: RuntimeListenerDeps, req: http.IncomingMessage, now: number): AuthResult {
	const parsed = readSignatureHeaders(req);
	if (!parsed) return { ok: false, status: 401, code: 'signature_missing' };
	if (parsed.targetNodeId !== deps.selfMeshIp) return { ok: false, status: 403, code: 'wrong_target_node' };
	if (Math.abs(now - parsed.ts) > SIGNATURE_TS_SKEW_MS) return { ok: false, status: 403, code: 'signature_stale' };

	const key = deps.findSigningKeyByKid(parsed.kid);
	if (!key) return { ok: false, status: 401, code: 'signing_key_unknown' };

	const fields: SignedRequestFields = {
		targetNodeId: parsed.targetNodeId,
		nonce: parsed.nonce,
		ts: parsed.ts,
		method: req.method ?? 'GET',
		host: req.headers.host ?? '',
		requestTarget: req.url ?? '/',
		clientIp: parsed.clientIp,
	};
	if (!verifyRequest(fields, parsed.signature, key.publicJwk)) return { ok: false, status: 401, code: 'signature_invalid' };

	// Replay check LAST — an invalid signature must never consume a nonce slot.
	if (!deps.replayCache.checkAndRemember(parsed.nonce, now)) return { ok: false, status: 401, code: 'signature_replayed' };

	return { ok: true, clientIp: parsed.clientIp };
}

type ResolveError = 'unknown-host' | 'no-route' | 'upstream-unavailable';
type ResolveResult = { target: { url: string; containerId: string } } | { error: ResolveError };

async function resolveTarget(deps: RuntimeListenerDeps, host: string, pathname: string): Promise<ResolveResult> {
	const app = deps.findAppByHost(host);
	if (!app) return { error: 'unknown-host' };

	// See the module PHASE-NOTE: one container per app host today, bound to `/`.
	const routes: Array<PathRoute<true>> = [{ prefix: '/', value: true }];
	if (matchLongestPrefix(pathname, routes) === undefined) return { error: 'no-route' };

	const container = await deps.findContainerByAppId(app.appId, app.workspaceId);
	if (!container || container.state !== 'running') return { error: 'upstream-unavailable' };

	const ip = await deps.getContainerIp(container.dockerContainerId).catch(() => null);
	if (!ip) return { error: 'upstream-unavailable' }; // container IP only — never a published host port

	return { target: { url: `http://${ip}:${container.port}`, containerId: container.id } };
}

/** Fresh forwarded-header set — NEVER copies an incoming X-Forwarded- or X-Privos- header. */
function buildForwardedHeaders(req: http.IncomingMessage, clientIp: string, host: string, hopByHop: Set<string> = HOP_BY_HOP): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		const lower = key.toLowerCase();
		if (hopByHop.has(lower)) continue;
		if (lower.startsWith('x-forwarded-') || lower.startsWith('x-privos-')) continue;
		out[key] = Array.isArray(value) ? value.join(', ') : value;
	}
	out['host'] = host; // the container gets the original public Host, not the mesh IP:port it's dialed on
	out['x-forwarded-for'] = clientIp;
	out['x-forwarded-proto'] = 'https';
	out['x-forwarded-host'] = host;
	return out;
}

function buildResponseHeaders(upstreamHeaders: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(upstreamHeaders)) {
		if (value === undefined) continue;
		if (RESP_HOP_BY_HOP.has(key.toLowerCase())) continue;
		if (key.toLowerCase() === 'set-cookie') {
			out[key] = stripPrivosLinkCookieDomains(Array.isArray(value) ? value : [value]);
			continue;
		}
		out[key] = value;
	}
	return out;
}

function sendPlain(res: http.ServerResponse, status: number, body: string): void {
	if (res.headersSent) { res.destroy(); return; }
	res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
	res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) { res.destroy(); return; }
	res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
	res.end(JSON.stringify(body));
}

/** 404 with a marker distinguishing "host unknown to THIS node" — the only
 * case the ingress listener is allowed to retry against another replica. */
function sendUnknownHost(res: http.ServerResponse): void {
	if (res.headersSent) { res.destroy(); return; }
	res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'x-privos-error': 'unknown-host' });
	res.end('404 Not Found');
}

async function handleRequest(deps: RuntimeListenerDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const now = (deps.now ?? Date.now)();
	const auth = authenticateRuntimeRequest(deps, req, now);
	if (!auth.ok) return sendJson(res, auth.status, { error: auth.code });

	const canonical = canonicalizePath(req.url ?? '/');
	if (!canonical) return sendPlain(res, 400, '400 Bad Request');
	if (BLOCKED_MCP_PATH.test(canonical.pathname)) return sendPlain(res, 404, '404 Not Found');

	const host = req.headers.host ?? '';
	const resolved = await resolveTarget(deps, host, canonical.pathname);
	if ('error' in resolved) {
		if (resolved.error === 'unknown-host') return sendUnknownHost(res);
		if (resolved.error === 'no-route') return sendPlain(res, 404, '404 Not Found');
		return sendPlain(res, 502, '502 Bad Gateway');
	}

	const method = req.method ?? 'GET';
	const hasBody = method !== 'GET' && method !== 'HEAD';
	try {
		const upstream = await request(`${resolved.target.url}${canonical.pathname}${canonical.search}`, {
			method: method as never,
			headers: buildForwardedHeaders(req, auth.clientIp, host),
			body: hasBody ? req : undefined,
			headersTimeout: 30_000,
			bodyTimeout: 0,
		});
		const respHeaders = buildResponseHeaders(upstream.headers);
		res.writeHead(upstream.statusCode, respHeaders);
		upstream.body.on('error', () => res.destroy());
		res.on('close', () => {
			if (!res.writableEnded) upstream.body.destroy();
		});
		upstream.body.pipe(res);
	} catch (err) {
		logger.warn({ err, host, target: resolved.target.url }, 'runtime upstream request failed');
		sendPlain(res, 502, '502 Bad Gateway');
	}
}

function rejectUpgrade(socket: net.Socket, status: number, reason: string): void {
	socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
}

function handleUpgrade(deps: RuntimeListenerDeps, req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
	const now = (deps.now ?? Date.now)();
	const auth = authenticateRuntimeRequest(deps, req, now);
	if (!auth.ok) return rejectUpgrade(clientSocket, auth.status, 'Forbidden');

	const canonical = canonicalizePath(req.url ?? '/');
	if (!canonical) return rejectUpgrade(clientSocket, 400, 'Bad Request');
	if (BLOCKED_MCP_PATH.test(canonical.pathname)) return rejectUpgrade(clientSocket, 404, 'Not Found');

	const host = req.headers.host ?? '';
	void resolveTarget(deps, host, canonical.pathname)
		.then((resolved) => {
			if ('error' in resolved) {
				return rejectUpgrade(clientSocket, resolved.error === 'upstream-unavailable' ? 502 : 404, 'Not Found');
			}
			const upstreamUrl = new URL(resolved.target.url);
			const upstream = net.connect(Number(upstreamUrl.port), upstreamUrl.hostname);
			const connectTimer = setTimeout(() => upstream.destroy(new Error('upstream connect timeout')), UPSTREAM_CONNECT_TIMEOUT_MS);

			upstream.once('connect', () => {
				clearTimeout(connectTimer);
				const headers = buildForwardedHeaders(req, auth.clientIp, host, UPGRADE_HOP_BY_HOP);
				const lines = [`${req.method} ${canonical.pathname}${canonical.search} HTTP/1.1`];
				for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
				upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
				if (head && head.length) upstream.write(head);
				upstream.pipe(clientSocket);
				clientSocket.pipe(upstream);
			});
			upstream.on('error', () => clientSocket.destroy());
			upstream.on('close', () => {
				clearTimeout(connectTimer);
				clientSocket.destroy();
			});
			clientSocket.on('error', () => upstream.destroy());
			clientSocket.on('close', () => upstream.destroy());
		})
		.catch(() => clientSocket.destroy());
}

/** Build a runtime listener over injectable deps (real docker-state/host-table in production; fakes in tests). */
export function createRuntimeListener(deps: RuntimeListenerDeps): http.Server {
	const server = http.createServer((req, res) => void handleRequest(deps, req, res));
	server.on('upgrade', (req, socket, head) => handleUpgrade(deps, req, socket as net.Socket, head));
	return server;
}

function productionDeps(): RuntimeListenerDeps {
	return {
		selfMeshIp: config.MESH_BIND_IP ?? '',
		findAppByHost: findRuntimeAppByHost,
		findSigningKeyByKid: findSigningKey,
		findContainerByAppId: (appId, workspaceId) => dockerState.findByAppId(appId, workspaceId),
		getContainerIp: (id) => containerManager.getContainerIp(id),
		replayCache: createReplayCache(),
	};
}

let server: http.Server | null = null;

export function startRuntimeListener(): Promise<void> {
	return new Promise((resolve, reject) => {
		const s = createRuntimeListener(productionDeps());
		server = s;
		const onBootError = (err: Error): void => reject(err);
		s.once('error', onBootError);
		s.listen(config.RUNTIME_PROXY_PORT, config.MESH_BIND_IP, () => {
			s.off('error', onBootError);
			s.on('error', (err) => logger.error({ err }, 'runtime listener server error'));
			logger.info({ port: config.RUNTIME_PROXY_PORT, host: config.MESH_BIND_IP }, 'runtime proxy listener listening');
			resolve();
		});
	});
}

export function stopRuntimeListener(): Promise<void> {
	return new Promise((resolve) => {
		const s = server;
		if (!s) return resolve();
		server = null;
		s.close(() => resolve());
		s.closeIdleConnections();
		const drain = setTimeout(() => s.closeAllConnections(), SHUTDOWN_DRAIN_MS);
		drain.unref();
	});
}
