/**
 * Native HTTP reverse proxy. Plain `node:http` server on `PROXY_PORT` (loopback):
 * per request, resolve `Host` → upstream container and stream the response.
 * cloudflared terminates TLS at the edge and forwards here — this server is HTTP
 * only and binds `127.0.0.1` (the tunnel connects from the same host).
 *
 * Streaming (no body buffering) for both HTTP and WebSocket (`upgrade`) so
 * long-lived SSE/WS connections pass through. No/unhealthy backend → 502.
 */
import http from 'node:http';
import net from 'node:net';
import { request } from 'undici';
import pino from 'pino';
import { config } from '../config.js';
import { router, type Router, type ResolvedTarget } from './proxy-router.js';

const logger = pino({ level: config.LOG_LEVEL }).child({ component: 'reverse-proxy' });

// Loopback: cloudflared forwards `*.<domain> → http://localhost:<PROXY_PORT>`
// from the same host, so the proxy never needs a public bind.
const BIND_HOST = '127.0.0.1';

// How long a raw upstream TCP connect may take before we give up (WS path).
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
// Bounded grace before long-lived (SSE/WS) connections are force-closed on shutdown.
const SHUTDOWN_DRAIN_MS = 5_000;

// Hop-by-hop headers must not be forwarded verbatim on plain HTTP proxying.
// `host` is dropped so undici sets it from the upstream origin.
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'host',
]);

// Hop-by-hop headers must not be forwarded from the upstream response to the
// client either (undici already dechunked the body, so drop framing headers).
const RESP_HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

/** Copy client headers minus hop-by-hop, adding the standard forwarded set. */
function buildForwardedHeaders(req: http.IncomingMessage, dropHopByHop: boolean): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (dropHopByHop && HOP_BY_HOP.has(key.toLowerCase())) continue;
		out[key] = Array.isArray(value) ? value.join(', ') : value;
	}
	out['x-forwarded-proto'] = 'https'; // TLS terminated at the Cloudflare edge
	out['x-forwarded-host'] = req.headers.host ?? '';
	const remote = req.socket.remoteAddress ?? '';
	const prior = req.headers['x-forwarded-for'];
	out['x-forwarded-for'] = prior ? `${Array.isArray(prior) ? prior.join(', ') : prior}, ${remote}` : remote;
	return out;
}

function send502(res: http.ServerResponse): void {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.writeHead(502, { 'content-type': 'text/plain' });
	res.end('502 Bad Gateway');
}

export function isPublicMcpPathBlocked(target: ResolvedTarget, rawUrl: string | undefined): boolean {
	if (!target.mcpV2) return false;
	let pathname: string;
	try {
		pathname = new URL(rawUrl || '/', 'http://privos-app.invalid').pathname;
	} catch {
		return true;
	}
	return /^(?:\/mcp(?:\/|$)|\/bootstrap(?:\/|$)|\/identity(?:\/|$)|\/\.well-known\/privos\/(?:bootstrap|identity)(?:\/|$)|\/api\/v1\/mcp-workload(?:\/|$))/i.test(pathname);
}

function send404(res: http.ServerResponse): void {
	res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
	res.end('404 Not Found');
}

async function handleRequest(r: Router, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	let target: ResolvedTarget | null;
	try {
		target = await r.resolve(req.headers.host);
	} catch (err) {
		logger.warn({ err, host: req.headers.host }, 'route resolution failed');
		return send502(res);
	}
	if (!target) return send502(res);
	if (isPublicMcpPathBlocked(target, req.url)) return send404(res);

	const method = req.method ?? 'GET';
	const hasBody = method !== 'GET' && method !== 'HEAD';
	try {
		const upstream = await request(`${target.url}${req.url ?? '/'}`, {
			method: method as never,
			headers: buildForwardedHeaders(req, true),
			body: hasBody ? req : undefined,
			headersTimeout: 30_000,
			bodyTimeout: 0, // allow long-lived streaming responses (SSE)
		});

		const respHeaders: Record<string, string | string[]> = {};
		for (const [key, value] of Object.entries(upstream.headers)) {
			if (RESP_HOP_BY_HOP.has(key.toLowerCase())) continue;
			if (value !== undefined) respHeaders[key] = value;
		}
		res.writeHead(upstream.statusCode, respHeaders);
		upstream.body.on('error', () => res.destroy());
		// If the client aborts mid-stream (SSE/long response), tear down the
		// upstream so it doesn't leak (bodyTimeout is disabled for streaming).
		res.on('close', () => {
			if (!res.writableEnded) upstream.body.destroy();
		});
		upstream.body.pipe(res);
	} catch (err) {
		logger.warn({ err, host: req.headers.host, target: target.url }, 'upstream request failed');
		send502(res);
	}
}

/** WebSocket passthrough: dial the upstream and pipe the raw socket both ways. */
function handleUpgrade(r: Router, req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
	void r
		.resolve(req.headers.host)
		.then((target) => {
			if (!target || isPublicMcpPathBlocked(target, req.url)) {
				clientSocket.destroy();
				return;
			}
			const upstreamUrl = new URL(target.url);
			const upstream = net.connect(Number(upstreamUrl.port), upstreamUrl.hostname);

			// Bound the connect phase — a black-holed upstream must not hang the
			// client until the OS TCP timeout. Cleared once connected (so it does
			// not double as an idle timeout on an active WS session).
			const connectTimer = setTimeout(() => upstream.destroy(new Error('upstream connect timeout')), UPSTREAM_CONNECT_TIMEOUT_MS);

			upstream.once('connect', () => {
				clearTimeout(connectTimer);
				// WS handshake needs Upgrade/Connection/Sec-WebSocket-* preserved —
				// forward the original headers verbatim, only adding X-Forwarded-*.
				const headers = buildForwardedHeaders(req, false);
				const lines = [`${req.method} ${req.url} HTTP/1.1`];
				for (const [key, value] of Object.entries(headers)) {
					lines.push(`${key}: ${value}`);
				}
				upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
				if (head && head.length) upstream.write(head);
				upstream.pipe(clientSocket);
				clientSocket.pipe(upstream);
			});
			// Tear down both halves together on error or close (no half-open leak).
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

/** Build a proxy server over a router (injectable for tests). */
export function createProxyServer(r: Router): http.Server {
	const server = http.createServer((req, res) => void handleRequest(r, req, res));
	server.on('upgrade', (req, socket, head) => handleUpgrade(r, req, socket as net.Socket, head));
	return server;
}

let server: http.Server | null = null;

export function startReverseProxy(): Promise<void> {
	return new Promise((resolve, reject) => {
		const s = createProxyServer(router);
		server = s;
		const onBootError = (err: Error): void => reject(err);
		s.once('error', onBootError);
		s.listen(config.PROXY_PORT, BIND_HOST, () => {
			s.off('error', onBootError);
			// Runtime errors after boot must be logged, not silently consumed.
			s.on('error', (err) => logger.error({ err }, 'reverse proxy server error'));
			logger.info({ port: config.PROXY_PORT, host: BIND_HOST }, 'native reverse proxy listening');
			resolve();
		});
	});
}

export function stopReverseProxy(): Promise<void> {
	return new Promise((resolve) => {
		const s = server;
		if (!s) return resolve();
		server = null;

		// Long-lived SSE/WS connections keep `close()` from completing; drop idle
		// ones immediately and force-close the rest after a bounded grace so
		// shutdown always finishes.
		s.close(() => resolve());
		s.closeIdleConnections();
		const drain = setTimeout(() => s.closeAllConnections(), SHUTDOWN_DRAIN_MS);
		drain.unref();
	});
}
