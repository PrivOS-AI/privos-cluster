/**
 * Interactive cluster setup: `npm run setup`.
 *
 * Reads the existing `.env` (values become prompt defaults), asks for the few
 * cluster-wide settings, writes `.env` atomically with 0600 perms, then prints
 * the cloudflared tunnel config + DNS commands + the JWT secret to register in
 * privos-hub. Idempotent — re-running preserves untouched keys; secrets are never
 * logged except the explicit hub-registration summary at the end.
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mergeEnv, renderCloudflaredIngress, renderDnsRouteCommands } from './cloudflared-ingress.js';

const ENV_PATH = new URL('../.env', import.meta.url).pathname;

/** Parse a KEY=VALUE `.env` body into a lookup (last value wins; comments ignored). */
function parseEnv(body: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of body.split('\n')) {
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

async function main(): Promise<void> {
	const rl = createInterface({ input: stdin, output: stdout });
	const ask = async (label: string, def = ''): Promise<string> => {
		const suffix = def ? ` [${def}]` : '';
		const answer = (await rl.question(`${label}${suffix}: `)).trim();
		return answer || def;
	};

	const existingBody = existsSync(ENV_PATH) ? await readFile(ENV_PATH, 'utf8') : '';
	const current = parseEnv(existingBody);

	console.log('\n=== privos-cluster setup ===\n');

	// JWT secret — keep existing, else generate a strong one (never prompt to type).
	let jwtSecret = current.JWT_SECRET && current.JWT_SECRET !== 'change-me-min-16-chars' ? current.JWT_SECRET : '';
	if (!jwtSecret) {
		jwtSecret = randomBytes(24).toString('base64url');
		console.log('Generated a new JWT_SECRET (shown in the summary below).');
	} else {
		console.log('Keeping the existing JWT_SECRET.');
	}

	const domains = await ask('Base domains (comma-separated, e.g. privos.link)', current.PRIVOS_DOMAINS ?? '');
	let mode = await ask('Reverse proxy mode (off|caddy|native)', current.REVERSE_PROXY_MODE ?? 'caddy');
	if (!['off', 'caddy', 'native'].includes(mode)) {
		console.log(`Unknown mode "${mode}" — defaulting to caddy.`);
		mode = 'caddy';
	}
	const proxyPort = await ask('Native proxy port', current.PROXY_PORT ?? '8080');
	const defMem = await ask('Default container memory (MB)', current.DEFAULT_MEMORY_MB ?? '256');
	const defCpus = await ask('Default container CPUs', current.DEFAULT_CPUS ?? '0.5');
	const defTmp = await ask('Default container /tmp (MB)', current.DEFAULT_TMP_MB ?? '64');

	rl.close();

	const domainList = domains.split(',').map((d) => d.trim()).filter(Boolean);
	if (mode === 'native' && domainList.length === 0) {
		console.error('\nERROR: native mode requires at least one base domain. Re-run and set domains.');
		process.exit(1);
	}

	const updates: Record<string, string> = {
		JWT_SECRET: jwtSecret,
		PRIVOS_DOMAINS: domainList.join(','),
		REVERSE_PROXY_MODE: mode,
		REVERSE_PROXY_ENABLED: mode === 'caddy' ? 'true' : (current.REVERSE_PROXY_ENABLED ?? 'false'),
		PROXY_PORT: proxyPort,
		DEFAULT_MEMORY_MB: defMem,
		DEFAULT_CPUS: defCpus,
		DEFAULT_TMP_MB: defTmp,
	};

	// Atomic write (temp + rename) then lock perms to 0600.
	const merged = mergeEnv(existingBody, updates);
	const tmp = `${ENV_PATH}.tmp-${randomBytes(4).toString('hex')}`;
	await writeFile(tmp, merged, { mode: 0o600 });
	await rename(tmp, ENV_PATH);
	await chmod(ENV_PATH, 0o600);
	console.log(`\nWrote ${ENV_PATH} (0600).`);

	// Operator-facing summary.
	console.log('\n--- Register in privos-hub (Add Cluster) ---');
	console.log(`JWT secret : ${jwtSecret}`);
	console.log('(This secret stays on the cluster host + hub only — never in the tunnel config.)');

	if (mode === 'native') {
		console.log('\n--- cloudflared: add to your tunnel config.yml ingress ---\n');
		console.log(renderCloudflaredIngress(domainList, Number(proxyPort)));
		console.log('\n--- cloudflared: publish wildcard DNS (replace <tunnel>) ---\n');
		console.log(renderDnsRouteCommands(domainList));
		console.log('\nThen set the Cloudflare zone SSL mode to "Full". Universal SSL covers');
		console.log('one-level subdomains for free; deeper (a.b.<domain>) needs Cloudflare ACM.');
	}
	console.log('\nDone.');
}

main().catch((err) => {
	console.error('setup failed:', err);
	process.exit(1);
});
