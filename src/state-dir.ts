/**
 * App Cluster state directory helpers.
 *
 * The state dir holds the paired credential and (transiently) the pair token
 * file the installer writes. It must be 0700, owned by the service user; every
 * file inside it is 0600. Used by the installer CLI (this phase) and by the
 * tunnel client / pairing redemption (phases 3/5) to persist and rotate the
 * cluster credential with no process restart.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Filename of the paired cluster credential inside the state dir. */
export const CREDENTIAL_FILENAME = 'credential';
/** Filename of the one-time pair token, deleted after redemption. */
export const PAIR_TOKEN_FILENAME = 'pair-token';
/**
 * Filename of the cluster id the Hub assigned at pairing. The Hub keys a tunnel
 * cluster by its own row id and looks it up from the connect JWT's `kid`, so a
 * paired cluster must sign with the id the Hub gave it, not the local
 * `FLEET_CLUSTER_ID` default.
 */
export const CLUSTER_ID_FILENAME = 'cluster-id';

/** Creates the state dir (if missing) and enforces 0700, even if it pre-existed with a looser mode. */
export function ensureStateDir(stateDir: string): void {
	fs.mkdirSync(stateDir, { recursive: true, mode: DIR_MODE });
	fs.chmodSync(stateDir, DIR_MODE);
}

/** Absolute path of `filename` inside `stateDir`. */
export function statePath(stateDir: string, filename: string): string {
	return path.join(stateDir, filename);
}

/** Writes `contents` to `stateDir/filename` at 0600, creating the state dir first. */
export function writeStateFile(stateDir: string, filename: string, contents: string): string {
	ensureStateDir(stateDir);
	const filePath = statePath(stateDir, filename);
	fs.writeFileSync(filePath, contents, { mode: FILE_MODE });
	// fs.writeFileSync's mode is subject to umask; chmod enforces the exact bits.
	fs.chmodSync(filePath, FILE_MODE);
	return filePath;
}

/** Reads `stateDir/filename`; returns `undefined` if it does not exist. */
export function readStateFile(stateDir: string, filename: string): string | undefined {
	try {
		return fs.readFileSync(statePath(stateDir, filename), 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw err;
	}
}

/** Deletes `stateDir/filename`; a no-op if it does not exist. */
export function deleteStateFile(stateDir: string, filename: string): void {
	try {
		fs.unlinkSync(statePath(stateDir, filename));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
}

/** Reports whether `stateDir` and every regular file inside it hold their required permission bits. */
export function checkStatePermissions(stateDir: string): { ok: boolean; issues: string[] } {
	const issues: string[] = [];
	let stat: fs.Stats;
	try {
		stat = fs.statSync(stateDir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, issues: [] };
		throw err;
	}
	if ((stat.mode & 0o777) !== DIR_MODE) {
		issues.push(`${stateDir} is mode ${(stat.mode & 0o777).toString(8)}, expected ${DIR_MODE.toString(8)}`);
	}
	for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const filePath = path.join(stateDir, entry.name);
		const fileStat = fs.statSync(filePath);
		if ((fileStat.mode & 0o777) !== FILE_MODE) {
			issues.push(`${filePath} is mode ${(fileStat.mode & 0o777).toString(8)}, expected ${FILE_MODE.toString(8)}`);
		}
	}
	return { ok: issues.length === 0, issues };
}
