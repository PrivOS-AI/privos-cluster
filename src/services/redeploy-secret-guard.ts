/**
 * The raw redeploy paths reconstruct a container's environment from its
 * `privos.env` label, which deliberately excludes operator secrets. Rebuilding
 * such a container that way would silently restart it with its secrets missing
 * — a quiet outage that looks like an app bug — so those containers are refused
 * here by default.
 *
 * An MCP v3 upgrade is the one caller allowed past that default refusal, and
 * it is admitted only on EVIDENCE read off the OLD container's own labels —
 * never on a bare "trust me" flag from the caller. Concretely: the caller's
 * `envVars` must restate every key (secret and non-secret) the old container
 * already had, `secretEnvKeys` must name every one of the old secret keys
 * (so none of them can end up written into the new container's world-readable
 * `privos.env` label), and `platformEnvVars` must be non-empty (every real MCP
 * v3 app has a subdomain and therefore a non-empty platform environment — an
 * empty one is a caller that forgot it, not a legitimate app). A caller that
 * fails any of these is refused exactly as if it had never claimed awareness.
 *
 * A label that fails to parse is refused OUTRIGHT, for every caller, upgrade
 * or not — there is no way to prove a container declares zero secrets from a
 * value that cannot be read. Reducing a parse failure to "treat as empty"
 * (which an earlier version of this guard did) fails OPEN exactly where the
 * whole guard exists to fail closed.
 */

class MalformedEnvLabelError extends Error {}

/** Parse the `privos.env.secret-keys` label — a JSON array of key names. Absent means none declared; malformed THROWS. */
function parseSecretKeyNames(raw: string | undefined): string[] {
	if (raw === undefined) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new MalformedEnvLabelError('privos.env.secret-keys is not valid JSON');
	}
	if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
		throw new MalformedEnvLabelError('privos.env.secret-keys is not a JSON array of strings');
	}
	return parsed;
}

/** Parse the `privos.env` label — the container's non-secret operator env as written at create time. Absent means none; malformed THROWS. */
function parseNonSecretEnvKeys(raw: string | undefined): string[] {
	if (raw === undefined) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new MalformedEnvLabelError('privos.env is not valid JSON');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new MalformedEnvLabelError('privos.env is not a JSON object');
	}
	return Object.keys(parsed);
}

function refuse(message: string): never {
	const error: Error & { statusCode?: number } = new Error(message);
	error.statusCode = 409;
	throw error;
}

export function assertRawRedeployAllowedForLabels(
	labels: Record<string, string>,
	upgrade?: {
		envVars: Record<string, string>;
		secretEnvKeys: string[];
		platformEnvVars: Record<string, string>;
	},
): void {
	let existingSecretKeys: string[];
	let existingNonSecretEnvKeys: string[];
	try {
		existingSecretKeys = parseSecretKeyNames(labels['privos.env.secret-keys']);
		existingNonSecretEnvKeys = parseNonSecretEnvKeys(labels['privos.env']);
	} catch (error) {
		if (error instanceof MalformedEnvLabelError) {
			refuse('This container\'s environment labels could not be read; redeploy it through its own lifecycle instead');
		}
		throw error;
	}

	if (upgrade && labels['privos.mcp.schema'] === '3') {
		const restatesEveryExistingKey = [...existingSecretKeys, ...existingNonSecretEnvKeys]
			.every((key) => key in upgrade.envVars);
		const declaresEveryExistingSecret = existingSecretKeys
			.every((key) => upgrade.secretEnvKeys.includes(key));
		const hasPlatformEnv = Object.keys(upgrade.platformEnvVars).length > 0;
		if (restatesEveryExistingKey && declaresEveryExistingSecret && hasPlatformEnv) return;
		refuse(
			'MCP v3 upgrade-aware redeploy must restate every existing environment key, ' +
			'declare every existing secret key, and carry a non-empty platform environment',
		);
	}

	if (labels['privos.mcp.schema'] !== '3' && existingSecretKeys.length === 0) return;
	refuse('This container holds operator secrets; redeploy it through its own lifecycle instead');
}
