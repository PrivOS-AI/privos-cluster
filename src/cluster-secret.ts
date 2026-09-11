/**
 * Per-request cluster secret resolution.
 *
 * `auth.ts`/`jwt.ts` used to close over `config.JWT_SECRET`, a value frozen
 * at process start (`export const config = loadConfig()`). A credential
 * written to the state dir after boot — first pairing, or a rotation from
 * re-pair — was therefore never read without a restart. `resolveClusterSecret`
 * is called per request instead, so pairing/rotation take effect immediately.
 *
 * Resolution order: paired credential (state-dir file) → `config.JWT_SECRET`
 * (fleet/master HTTP deployments, unchanged) → `undefined` (unpaired —
 * callers refuse the request `401 cluster_unpaired`).
 */
import { config } from './config.js';
import { CREDENTIAL_FILENAME, readStateFile } from './state-dir.js';

/**
 * Pure resolution logic, no config access — the seam tests exercise directly
 * so they can cover every state (including "no config secret at all")
 * without fighting JS default-parameter semantics on the process's real,
 * import-time-frozen config singleton.
 */
export function resolveClusterSecretFrom(stateDir: string, configSecret: string | undefined): string | undefined {
	const credential = readStateFile(stateDir, CREDENTIAL_FILENAME);
	if (credential !== undefined) {
		const trimmed = credential.trim();
		if (trimmed) return trimmed;
	}
	return configSecret;
}

/** Production entry point: resolves against the real state dir and config. */
export function resolveClusterSecret(): string | undefined {
	return resolveClusterSecretFrom(config.PRIVOS_STATE_DIR, config.JWT_SECRET);
}
