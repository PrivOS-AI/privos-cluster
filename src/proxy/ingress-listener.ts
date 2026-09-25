/**
 * Loopback ingress listener (`INGRESS`/`BOTH` role). Only cloudflared's local
 * connector for the `privos-apps` tunnel ever dials `127.0.0.1:APPS_INGRESS_PORT`
 * — Cloudflare itself terminates TLS and injects `CF-Connecting-IP`, which is
 * the ONLY source this listener trusts for the client's real IP. Any
 * client-sent `X-Forwarded-*`/`X-Privos-*` header is dropped before the
 * request is re-signed and forwarded to a runtime node over the mesh.
 *
 * Exact-host lookup only — an unknown host is a 404, NEVER a `splitHost`
 * fallback (that fallback exists solely for the legacy loopback listener's
 * plain/v2 workloads and must never see a v3 public host).
 *
 * PHASE-NOTE: a suspended workspace's rows stay in the ingress table with
 * `suspended: true` (they carry no per-app data the runtime table doesn't
 * already own), so this listener answers the "workspace suspended" page
 * itself rather than paying a mesh hop to a runtime node that has no way to
 * distinguish "suspended" from "unknown host" in its own (phase-3) table.
 */
import http from 'node:http';
import net from 'node:net';
import { request } from 'undici';
import pino from 'pino';
import { config } from '../config.js';
import { generateNonce, signRequest, type SignedRequestFields, type SigningIdentity, loadOrCreateSigningIdentity } from './forward-signature.js';
import { findIngressRuleByHost, ingressTableAgeMs, type IngressRule } from './host-table.js';

const logger = pino({ level: config.LOG_LEVEL }).child({ component: 'ingress-listener' });

const BIND_HOST = '127.0.0.1';
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const SHUTDOWN_DRAIN_MS = 5_000;
const HEALTH_STALE_MS = 10 * 60_000;

// 'host' is intentionally NOT in this set: requirement 20 forwards to the
// runtime node WITH the original Host — unlike the legacy v2 listener, which
// drops it so undici can rewrite it to the upstream origin.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
// Used only for a WebSocket upgrade: 'connection'/'upgrade' must reach the
// runtime node's raw socket write verbatim or the handshake can never
// complete — unlike the plain-request path above, this is hand-written HTTP,
// not handed to undici, so nothing else regenerates them.
const UPGRADE_HOP_BY_HOP = new Set(['keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding']);
const RESP_HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export interface IngressListenerDeps {
	/** Reported at `/_privos/ingress-id` for per-connector health probes. */
	nodeId: string;
	/** This node's own mesh IP, used only to prefer a local runtime replica (BOTH role). */
	selfMeshIp?: string;
	runtimeProxyPort: number;
	findRuleByHost: (host: string) => IngressRule | undefined;
	signingIdentity: SigningIdentity;
	isTableStale: (now: number) => boolean;
	now?: () => number;
	/** Resolves a rule replica's mesh IP to the actual dial target. Defaults to
	 * `{ host: meshIp, port: runtimeProxyPort }` — overridden only in tests, to
	 * simulate multiple replicas without needing distinct real loopback addresses. */
	dialTarget?: (meshIp: string) => { host: string; port: number };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function hostOnly(rawHost: string | undefined): string {
	return (rawHost ?? '').split(':')[0].trim().toLowerCase().replace(/\.$/, '');
}

/** `CF-Connecting-IP` only — never trust a client-sent `X-Forwarded-For`. */
function clientIpFrom(req: http.IncomingMessage): string | null {
	const value = firstHeader(req.headers['cf-connecting-ip']);
	return value && value.trim() ? value.trim() : null;
}

/** Prefer this node's own mesh IP when it is one of the rule's replicas (BOTH role, local shortcut). */
function pickNodeOrder(rule: IngressRule, selfMeshIp: string | undefined): string[] {
	if (!selfMeshIp) return rule.nodes;
	const local = rule.nodes.filter((n) => n === selfMeshIp);
	const rest = rule.nodes.filter((n) => n !== selfMeshIp);
	return [...local, ...rest];
}

function stripClientHeaders(req: http.IncomingMessage, hopByHop: Set<string> = HOP_BY_HOP): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		const lower = key.toLowerCase();
		if (hopByHop.has(lower) || lower === 'host') continue; // host is set explicitly below
		if (lower.startsWith('x-forwarded-') || lower.startsWith('x-privos-')) continue; // client-sent — never trusted
		out[key] = Array.isArray(value) ? value.join(', ') : value;
	}
	return out;
}

function signedHeadersFor(
	deps: IngressListenerDeps,
	req: http.IncomingMessage,
	meshIp: string,
	host: string,
	clientIp: string,
	hopByHop: Set<string> = HOP_BY_HOP,
): Record<string, string> {
	const nonce = generateNonce();
	const ts = Date.now();
	const fields: SignedRequestFields = {
		targetNodeId: meshIp,
		nonce,
		ts,
		method: req.method ?? 'GET',
		host,
		requestTarget: req.url ?? '/',
		clientIp,
	};
	return {
		...stripClientHeaders(req, hopByHop),
		host,
		'x-privos-target-node': meshIp,
		'x-privos-nonce': nonce,
		'x-privos-ts': String(ts),
		'x-privos-kid': deps.signingIdentity.kid,
		'x-privos-client-ip': clientIp,
		'x-privos-sig': signRequest(fields, deps.signingIdentity.privateKey),
	};
}

function buildResponseHeaders(upstreamHeaders: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(upstreamHeaders)) {
		if (value === undefined) continue;
		if (RESP_HOP_BY_HOP.has(key.toLowerCase())) continue;
		out[key] = value;
	}
	return out;
}

function sendPlain(res: http.ServerResponse, status: number, body: string): void {
	if (res.headersSent) { res.destroy(); return; }
	res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
	res.end(body);
}

function sendSuspended(res: http.ServerResponse): void {
	if (res.headersSent) { res.destroy(); return; }
	res.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'retry-after': '60' });
	res.end('503 Service Unavailable — workspace suspended');
}

/** Consumes and discards a skipped upstream response body (no dangling stream on retry). */
async function drain(stream: NodeJS.ReadableStream): Promise<void> {
	return new Promise((resolve) => {
		stream.on('data', () => undefined);
		stream.on('end', resolve);
		stream.on('error', resolve);
	});
}

async function handleRequest(deps: IngressListenerDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const url = req.url ?? '/';
	const pathOnly = url.split('?')[0];

	if (pathOnly === '/_privos/ingress-id') {
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end(deps.nodeId);
		return;
	}
	if (pathOnly === '/healthz') {
		const now = (deps.now ?? Date.now)();
		if (deps.isTableStale(now)) return sendPlain(res, 503, '503 stale');
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('ok');
		return;
	}

	const host = hostOnly(req.headers.host);
	const rule = host ? deps.findRuleByHost(host) : undefined;
	if (!rule) return sendPlain(res, 404, '404 Not Found'); // exact-host miss — NEVER a splitHost fallback
	if (rule.suspended) return sendSuspended(res);

	const clientIp = clientIpFrom(req);
	if (!clientIp) return sendPlain(res, 400, '400 Bad Request');

	const method = req.method ?? 'GET';
	const hasBody = method !== 'GET' && method !== 'HEAD';
	const order = pickNodeOrder(rule, deps.selfMeshIp);

	let bodyConsumed = false; // a streamed request body is NEVER re-sent — see the module doc
	let lastError = { status: 502, body: '502 Bad Gateway' };

	for (const meshIp of order) {
		if (bodyConsumed) break;
		const headers = signedHeadersFor(deps, req, meshIp, req.headers.host ?? host, clientIp);
		const dial = (deps.dialTarget ?? ((ip) => ({ host: ip, port: deps.runtimeProxyPort })))(meshIp);

		try {
			const upstream = await request(`http://${dial.host}:${dial.port}${url}`, {
				method: method as never,
				headers,
				body: hasBody ? req : undefined,
				headersTimeout: 30_000,
				bodyTimeout: 0,
			});
			if (hasBody) bodyConsumed = true;

			if (upstream.statusCode === 404 && firstHeader(upstream.headers['x-privos-error']) === 'unknown-host') {
				await drain(upstream.body);
				lastError = { status: 404, body: '404 Not Found' };
				continue; // safe: no response byte has been sent to the client yet
			}

			const respHeaders = buildResponseHeaders(upstream.headers);
			res.writeHead(upstream.statusCode, respHeaders);
			upstream.body.on('error', () => res.destroy());
			res.on('close', () => {
				if (!res.writableEnded) upstream.body.destroy();
			});
			upstream.body.pipe(res);
			return;
		} catch (err) {
			if (hasBody) bodyConsumed = true;
			logger.warn({ err, host, meshIp }, 'ingress forward failed');
			lastError = { status: 502, body: '502 Bad Gateway' };
		}
	}

	sendPlain(res, lastError.status, lastError.body);
}

function handleUpgrade(deps: IngressListenerDeps, req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
	const host = hostOnly(req.headers.host);
	const rule = host ? deps.findRuleByHost(host) : undefined;
	if (!rule || rule.suspended) { clientSocket.destroy(); return; }

	const clientIp = clientIpFrom(req);
	if (!clientIp) { clientSocket.destroy(); return; }

	const meshIp = pickNodeOrder(rule, deps.selfMeshIp)[0];
	if (!meshIp) { clientSocket.destroy(); return; }

	const headers = signedHeadersFor(deps, req, meshIp, req.headers.host ?? host, clientIp, UPGRADE_HOP_BY_HOP);
	const dial = (deps.dialTarget ?? ((ip) => ({ host: ip, port: deps.runtimeProxyPort })))(meshIp);
	const upstream = net.connect(dial.port, dial.host);
	const connectTimer = setTimeout(() => upstream.destroy(new Error('upstream connect timeout')), UPSTREAM_CONNECT_TIMEOUT_MS);

	upstream.once('connect', () => {
		clearTimeout(connectTimer);
		const lines = [`${req.method} ${req.url} HTTP/1.1`];
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
}

/** Build an ingress listener over injectable deps (real host-table/signing key in production; fakes in tests). */
export function createIngressListener(deps: IngressListenerDeps): http.Server {
	const server = http.createServer((req, res) => void handleRequest(deps, req, res));
	server.on('upgrade', (req, socket, head) => handleUpgrade(deps, req, socket as net.Socket, head));
	return server;
}

let server: http.Server | null = null;

export async function startIngressListener(): Promise<void> {
	const signingIdentity = await loadOrCreateSigningIdentity(config.PROXY_INGRESS_SIGNING_KEY_PATH, config.FLEET_NODE_ID as string);
	const deps: IngressListenerDeps = {
		nodeId: config.FLEET_NODE_ID as string,
		selfMeshIp: config.MESH_BIND_IP,
		runtimeProxyPort: config.RUNTIME_PROXY_PORT,
		findRuleByHost: findIngressRuleByHost,
		signingIdentity,
		isTableStale: (now) => {
			const age = ingressTableAgeMs(now);
			return age === null || age > HEALTH_STALE_MS;
		},
	};

	return new Promise((resolve, reject) => {
		const s = createIngressListener(deps);
		server = s;
		const onBootError = (err: Error): void => reject(err);
		s.once('error', onBootError);
		s.listen(config.APPS_INGRESS_PORT, BIND_HOST, () => {
			s.off('error', onBootError);
			s.on('error', (err) => logger.error({ err }, 'ingress listener server error'));
			logger.info({ port: config.APPS_INGRESS_PORT, host: BIND_HOST }, 'ingress proxy listener listening');
			resolve();
		});
	});
}

export function stopIngressListener(): Promise<void> {
	return new Promise((resolve) => {
		const s = server;
		if (!s) return resolve();
		server = null;
		s.close(() => resolve());
		s.closeIdleConnections();
		const drain2 = setTimeout(() => s.closeAllConnections(), SHUTDOWN_DRAIN_MS);
		drain2.unref();
	});
}
