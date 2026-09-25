/**
 * Host → container routing for the native reverse proxy.
 *
 * The proxy is fronted by a Cloudflare Tunnel that terminates TLS at the edge
 * and forwards `<subdomain>.<domain>` requests here over plain HTTP. This module
 * turns a request's `Host` into an upstream container URL:
 *
 *   Host → split into (subdomain, baseDomain) → validate → findByHost →
 *   health gate (only `running`) → container internal URL.
 *
 * Two guards keep the proxy from becoming an open relay:
 *   - baseDomain MUST be one of the configured `PRIVOS_DOMAINS` (foreign host → null).
 *   - exactly ONE subdomain label (`a.b.example.com` rejected) — matches the free
 *     Cloudflare Universal SSL depth (one level); deeper needs ACM (out of scope).
 *
 * A THIRD guard lives one layer down: the injected `findByHost` (production:
 * `docker-state.findByHost`) excludes schema-3 (v3) containers outright — v3
 * public hosts are routed exclusively by the new ingress/runtime listeners
 * (`src/proxy/{ingress,runtime}-listener.ts`), never by this loopback fallback.
 *
 * Resolutions are cached with a short TTL; `refreshRoutes()` invalidates the cache
 * after any deploy/remove/redeploy so a new host routes within one lifecycle cycle.
 */
import { containerManager } from '../docker/index.js';
import * as dockerState from '../docker/docker-state.js';
import { getDomains } from '../services/settings-service.js';
import type { Container } from '../types/index.js';

export interface ResolvedTarget {
	/** Upstream origin, e.g. `http://172.18.0.5:3001` or `http://localhost:49155`. */
	url: string;
	/** The cluster container id this host resolved to (for logging/metrics). */
	containerId: string;
	/** Public proxy must block MCP/bootstrap/identity surfaces for v2 workloads. */
	mcpV2: boolean;
}

const DEFAULT_TTL_MS = 5_000;

/**
 * Split a request Host into (subdomain, baseDomain) against the configured base
 * domains. Returns null for: empty host, apex host (no subdomain), a subdomain
 * with more than one label, or a base domain not in the allowlist.
 */
export function splitHost(
	rawHost: string | undefined,
	domains: string[],
): { subdomain: string; domain: string } | null {
	if (!rawHost) return null;
	// Strip any port, trailing dot, and normalize case.
	const host = rawHost.split(':')[0].trim().toLowerCase().replace(/\.$/, '');
	if (!host) return null;

	for (const raw of domains) {
		const base = raw.trim().toLowerCase();
		if (!base) continue;
		if (host === base) return null; // apex — not an app subdomain
		if (host.endsWith(`.${base}`)) {
			const subdomain = host.slice(0, host.length - base.length - 1);
			// Enforce exactly one label (free Universal SSL depth).
			if (!subdomain || subdomain.includes('.')) return null;
			return { subdomain, domain: base };
		}
	}
	return null; // foreign host — open-relay guard
}

/**
 * Derive the upstream URL for a resolved container. Health gate: only a `running`
 * container is routable; anything else returns null (caller sends 502). Prefer the
 * container's network IP (reachable both on-host and when the cluster shares the
 * app network); fall back to the published host port.
 */
export function targetForContainer(c: Container, ip: string | null): string | null {
	if (c.state !== 'running') return null; // health gate
	if (ip) return `http://${ip}:${c.port}`;
	if (c.hostPort) return `http://localhost:${c.hostPort}`;
	return null;
}

export interface RouterDeps {
	findByHost: (subdomain: string, domain: string | null) => Promise<Container | null>;
	getContainerIp: (dockerContainerId: string) => Promise<string | null>;
	getDomains: () => string[];
	now?: () => number;
	ttlMs?: number;
}

export interface Router {
	resolve: (rawHost: string | undefined) => Promise<ResolvedTarget | null>;
	refreshRoutes: () => void;
}

/**
 * Build a router over injectable deps (real docker-state in production; fakes in
 * tests — no Docker required). Positive resolutions are cached for `ttlMs`.
 */
export function createRouter(deps: RouterDeps): Router {
	const cache = new Map<string, { target: ResolvedTarget; expires: number }>();
	const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
	const now = deps.now ?? Date.now;

	async function resolve(rawHost: string | undefined): Promise<ResolvedTarget | null> {
		const split = splitHost(rawHost, deps.getDomains());
		if (!split) return null;

		const key = `${split.subdomain}.${split.domain}`;
		const cached = cache.get(key);
		if (cached && cached.expires > now()) return cached.target;

		const container = await deps.findByHost(split.subdomain, split.domain);
		if (!container || container.state !== 'running') return null;

		let ip: string | null = null;
		try {
			ip = await deps.getContainerIp(container.dockerContainerId);
		} catch {
			ip = null; // fall back to host port
		}
		const url = targetForContainer(container, ip);
		if (!url) return null;

		const target: ResolvedTarget = { url, containerId: container.id, mcpV2: container.mcpV2 === true };
		cache.set(key, { target, expires: now() + ttl });
		return target;
	}

	function refreshRoutes(): void {
		cache.clear();
	}

	return { resolve, refreshRoutes };
}

/** Production singleton wired to live docker-state + container networking. */
export const router: Router = createRouter({
	findByHost: (sub, domain) => dockerState.findByHost(sub, domain),
	getContainerIp: (id) => containerManager.getContainerIp(id),
	getDomains,
});

/** Invalidate the route cache — called by lifecycle after deploy/remove/redeploy. */
export function refreshRoutes(): void {
	router.refreshRoutes();
}
