#!/usr/bin/env node
/**
 * `privos-app-cluster` — install/run/update/uninstall/status entry point.
 *
 * A thin bootstrapper: it never runs the long-lived service itself (except
 * `run`'s foreground dev path) — `install` resolves a stable global install
 * and hands the service off to systemd (Linux only, D20).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CREDENTIAL_FILENAME, PAIR_TOKEN_FILENAME, checkStatePermissions, ensureStateDir, readStateFile, writeStateFile } from '../state-dir.js';
import {
	CliExitError,
	DEFAULT_STATE_DIR,
	ENV_FILE_PATH,
	SERVICE_NAME,
	assertLinuxServiceSupported,
	parseConnectArgs,
	parseUninstallArgs,
	performInstall,
	performUninstall,
	performUpdate,
} from './service-install.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// dist/cli/privos-app-cluster.js -> package root is two levels up.
const PACKAGE_ROOT = path.join(HERE, '..', '..');
const ARTIFACT_CEILING_BYTES = 250_000_000;

function readPackageVersion(): string {
	const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string };
	return pkg.version;
}

const HELP = `privos-app-cluster <command> [options]

Commands:
  install    Install and start the App Cluster as a systemd system service (Linux only)
  run        Run the App Cluster in the foreground (developer / macOS path, not for production)
  update     Reinstall the global package (same provenance checks) and restart the service
  uninstall  Stop and remove the service (add --purge to also remove state)
  status     Print a local diagnostic summary (no network calls)

install/run options:
  --hub-url <url>              Required. The Hub's base URL.
  --pair-token-file <path>     Recommended. Read the one-time pair token from this file.
  --pair-token-stdin           Read the one-time pair token from stdin.
  --force                      Install even if this host already runs an App Cluster container.
  --pair-token <token>         Deprecated: exposes the token via ps, shell history, and sudo/auditd logs.
  --state-dir <path>           Defaults to ${DEFAULT_STATE_DIR}.

uninstall options:
  --purge                      Also remove the env file, state dir, and system user.
`;

function resolvePairTokenValue(args: ReturnType<typeof parseConnectArgs>): string {
	if (args.pairToken.kind === 'argv') return args.pairToken.token;
	if (args.pairToken.kind === 'file') return fs.readFileSync(args.pairToken.path, 'utf8').trim();
	return fs.readFileSync(0, 'utf8').trim();
}

async function runInstall(argv: string[]): Promise<void> {
	assertLinuxServiceSupported(process.platform);
	const args = parseConnectArgs(argv);
	if (args.deprecationWarning) console.warn(args.deprecationWarning);
	const version = readPackageVersion();
	const { alreadyInstalled } = await performInstall({ ...args, version });
	console.log(
		alreadyInstalled
			? `privos-app-cluster already installed — converged to version ${version}.`
			: `privos-app-cluster installed and started (version ${version}).`,
	);
	console.log(`Check status with: systemctl status ${SERVICE_NAME}`);
	console.log(
		'WARNING: the service user is a member of the docker group, which is root-equivalent on this host (docker.sock access).',
	);
}

/** Developer / macOS path: runs the service in the foreground, never through systemd. */
function runForeground(argv: string[]): void {
	const args = parseConnectArgs(argv);
	if (args.deprecationWarning) console.warn(args.deprecationWarning);

	ensureStateDir(args.stateDir);
	const pairTokenPath = writeStateFile(args.stateDir, PAIR_TOKEN_FILENAME, resolvePairTokenValue(args));

	const serverScript = path.join(PACKAGE_ROOT, 'dist', 'server.js');
	const result = spawnSync(process.execPath, [serverScript], {
		stdio: 'inherit',
		env: {
			...process.env,
			PRIVOS_HUB_URL: args.hubUrl,
			PRIVOS_PAIR_TOKEN_FILE: pairTokenPath,
			PRIVOS_STATE_DIR: args.stateDir,
			CLUSTER_OPERATOR_ROUTES: 'off',
		},
	});
	process.exit(result.status ?? 1);
}

async function runUpdate(): Promise<void> {
	assertLinuxServiceSupported(process.platform);
	const version = readPackageVersion();
	await performUpdate(version);
	console.log(`privos-app-cluster updated and restarted (version ${version}).`);
}

async function runUninstall(argv: string[]): Promise<void> {
	assertLinuxServiceSupported(process.platform);
	const args = parseUninstallArgs(argv);
	await performUninstall(args);
	console.log(
		args.purge
			? 'privos-app-cluster uninstalled; env file, state dir, and system user removed.'
			: 'privos-app-cluster uninstalled; env file and state dir preserved (use --purge to remove them).',
	);
}

function systemctlQuery(subcommand: string): string {
	try {
		const result = spawnSync('systemctl', [subcommand, SERVICE_NAME], { encoding: 'utf8' });
		return (result.stdout || result.stderr || '').trim() || 'unknown';
	} catch (err) {
		return `unavailable (${(err as Error).message})`;
	}
}

function dockerEngineVersion(): string {
	try {
		const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
		if (result.status === 0) return result.stdout.trim();
		return `unavailable (${(result.stderr || 'docker not reachable').trim()})`;
	} catch (err) {
		return `unavailable (${(err as Error).message})`;
	}
}

/** Reads a numeric env var out of the raw `.env` file contents (the CLI never loads the full zod `config.ts` schema — see the file doc comment — so this mirrors, rather than imports, `config.ts`'s own defaults for the two local-runtime artifact settings). */
function envNumber(envContents: string | undefined, name: string, fallback: number): number {
	const match = envContents ? new RegExp(`^${name}=(.*)$`, 'm').exec(envContents)?.[1] : undefined;
	const parsed = match ? Number(match) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Local-runtime artifact-staging headroom: free space at the state dir vs. `ceilingBytes * multiplier` (`ArtifactStore`'s free-space preflight, `local-runtime/artifact-store.ts`). */
function freeDiskReport(dir: string, ceilingBytes: number, multiplier: number): string {
	let target = dir;
	while (!fs.existsSync(target)) {
		const parent = path.dirname(target);
		if (parent === target) break;
		target = parent;
	}
	try {
		const stats = fs.statfsSync(target);
		const freeBytes = stats.bavail * stats.bsize;
		const neededBytes = ceilingBytes * multiplier;
		const ok = freeBytes >= neededBytes;
		return `${Math.round(freeBytes / 1_000_000)} MB free at ${target} (${ok ? 'ok' : 'BELOW'} the ${Math.round(neededBytes / 1_000_000)} MB headroom needed for a ${Math.round(ceilingBytes / 1_000_000)} MB artifact at ${multiplier}x)`;
	} catch (err) {
		return `unknown (${(err as Error).message})`;
	}
}

/** Local-state-only diagnostic — never makes a network call. */
function runStatus(): void {
	const envContents = fs.existsSync(ENV_FILE_PATH) ? fs.readFileSync(ENV_FILE_PATH, 'utf8') : undefined;
	const hubUrl = envContents ? /^PRIVOS_HUB_URL=(.*)$/m.exec(envContents)?.[1] : undefined;
	const stateDir = envContents ? (/^PRIVOS_STATE_DIR=(.*)$/m.exec(envContents)?.[1] ?? DEFAULT_STATE_DIR) : DEFAULT_STATE_DIR;
	const artifactCeilingBytes = envNumber(envContents, 'CLUSTER_LOCAL_RUNTIME_MAX_ARTIFACT_BYTES', ARTIFACT_CEILING_BYTES);
	const freeSpaceMultiplier = envNumber(envContents, 'CLUSTER_LOCAL_RUNTIME_FREE_SPACE_MULTIPLIER', 3);

	const hasCredential = readStateFile(stateDir, CREDENTIAL_FILENAME) !== undefined;
	const hasPairToken = readStateFile(stateDir, PAIR_TOKEN_FILENAME) !== undefined;
	const pairingState = hasCredential ? 'paired' : hasPairToken ? 'pairing (token written, not yet redeemed)' : 'unpaired';
	const permissions = checkStatePermissions(stateDir);

	console.log(`Hub URL:         ${hubUrl ?? '(not configured — run "install" or "run")'}`);
	console.log(`Pairing state:   ${pairingState}`);
	console.log(`Service state:   active=${systemctlQuery('is-active')} enabled=${systemctlQuery('is-enabled')}`);
	console.log(`Docker engine:   ${dockerEngineVersion()}`);
	console.log('Clock skew:      unknown (no successful hello recorded yet)');
	console.log(`State dir perms: ${permissions.ok ? 'ok' : permissions.issues.join('; ')}`);
	console.log(`Artifact headroom: ${freeDiskReport(stateDir, artifactCeilingBytes, freeSpaceMultiplier)}`);
}

async function main(): Promise<void> {
	const [, , command, ...rest] = process.argv;

	if (command === '--help' || command === '-h') {
		console.log(HELP);
		process.exit(0);
	}
	if (!command) {
		console.log(HELP);
		process.exit(1);
	}

	try {
		switch (command) {
			case 'install':
				await runInstall(rest);
				return;
			case 'run':
				runForeground(rest);
				return;
			case 'update':
				await runUpdate();
				return;
			case 'uninstall':
				await runUninstall(rest);
				return;
			case 'status':
				runStatus();
				return;
			default:
				console.error(`unknown command: ${command}\n`);
				console.log(HELP);
				process.exit(2);
		}
	} catch (err) {
		if (err instanceof CliExitError) {
			console.error(err.message);
			process.exit(err.exitCode);
		}
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

void main();
