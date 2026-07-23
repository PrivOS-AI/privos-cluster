/**
 * Pure helpers for the setup wizard: render the cloudflared tunnel config the
 * operator must apply, and merge values into an existing `.env` without clobbering
 * untouched keys/comments. No I/O here so both are trivially unit-testable.
 *
 * The cluster never owns cloudflared — it only *emits* the snippet. cloudflared
 * terminates TLS at the Cloudflare edge and forwards `*.<domain>` to the proxy.
 */

/** One `ingress` entry per base domain wildcard + a 404 catch-all. */
export function renderCloudflaredIngress(domains: string[], proxyPort: number): string {
	const bases = domains.map((d) => d.trim()).filter(Boolean);
	const lines: string[] = ['ingress:'];
	for (const base of bases) {
		lines.push(`  - hostname: "*.${base}"`);
		lines.push(`    service: http://localhost:${proxyPort}`);
	}
	lines.push('  - service: http_status:404');
	return lines.join('\n');
}

/** The `cloudflared tunnel route dns` commands that publish the wildcard DNS. */
export function renderDnsRouteCommands(domains: string[], tunnel = '<tunnel>'): string {
	return domains
		.map((d) => d.trim())
		.filter(Boolean)
		.map((base) => `cloudflared tunnel route dns ${tunnel} "*.${base}"`)
		.join('\n');
}

/**
 * Merge `updates` into an existing `.env` body. Existing keys are updated in place
 * (preserving order + surrounding comments/blank lines); new keys are appended.
 * Values are written verbatim (callers pass already-safe values).
 */
export function mergeEnv(existing: string, updates: Record<string, string>): string {
	const remaining = new Map(Object.entries(updates));
	const keyRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;

	const lines = existing.length ? existing.split('\n') : [];
	const out = lines.map((line) => {
		const match = keyRe.exec(line);
		if (match && remaining.has(match[1])) {
			const key = match[1];
			const value = remaining.get(key)!;
			remaining.delete(key);
			return `${key}=${value}`;
		}
		return line;
	});

	// Append any keys not already present.
	if (remaining.size) {
		if (out.length && out[out.length - 1].trim() !== '') out.push('');
		for (const [key, value] of remaining) out.push(`${key}=${value}`);
	}
	return out.join('\n');
}
