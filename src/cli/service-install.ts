/**
 * `privos-app-cluster install|update|uninstall` — Linux systemd service lifecycle.
 *
 * Every function that decides *what* to do (OS gate, arg parsing, unit/env
 * rendering, command building) is pure and unit-tested in
 * `service-install.test.ts`. The functions that actually touch the system
 * (`performInstall`/`performUpdate`/`performUninstall`) are a thin executor
 * built on top of those pure planners, so a test never needs a privileged call
 * to exercise the decision logic. macOS gets no LaunchDaemon in v1 — `install`
 * refuses there and points at the foreground `run` command instead (D20).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ensureStateDir, writeStateFile, PAIR_TOKEN_FILENAME } from '../state-dir.js';

export const PACKAGE_NAME = '@privos_ai/app-cluster';
export const SERVICE_NAME = 'privos-app-cluster';
export const SERVICE_USER = 'privos-app-cluster';
export const DOCKER_GROUP = 'docker';
export const ENV_FILE_PATH = '/etc/privos-app-cluster/app-cluster.env';
export const UNIT_FILE_PATH = '/etc/systemd/system/privos-app-cluster.service';
export const DEFAULT_STATE_DIR = '/var/lib/privos-app-cluster';

export const PAIR_TOKEN_ARGV_DEPRECATION_WARNING =
	'WARNING: --pair-token exposes the token in `ps`, shell history, and sudo/auditd logs. ' +
	'Prefer --pair-token-file <path> or --pair-token-stdin.';

const RUN_GUIDANCE = 'privos-app-cluster run --hub-url <url> --pair-token-file <path>';

/** Raised for every user-facing CLI failure; carries the process exit code to use. */
export class CliExitError extends Error {
	constructor(
		readonly exitCode: number,
		message: string,
	) {
		super(message);
		this.name = 'CliExitError';
	}
}

// ---------------------------------------------------------------------------
// OS gate
// ---------------------------------------------------------------------------

/** `install`/`update`/`uninstall` manage a systemd unit — Linux only. */
export function assertLinuxServiceSupported(platform: NodeJS.Platform): void {
	if (platform === 'linux') return;
	if (platform === 'darwin') {
		throw new CliExitError(
			2,
			`privos-app-cluster: the supervised service is Linux-only. On macOS, run it in the foreground instead:\n  ${RUN_GUIDANCE}`,
		);
	}
	throw new CliExitError(2, `privos-app-cluster: unsupported platform "${platform}" — only Linux is supported.`);
}

// ---------------------------------------------------------------------------
// Argument parsing (pure)
// ---------------------------------------------------------------------------

export type PairTokenSource =
	| { kind: 'file'; path: string }
	| { kind: 'stdin' }
	| { kind: 'argv'; token: string };

export interface ConnectArgs {
	hubUrl: string;
	pairToken: PairTokenSource;
	stateDir: string;
	/** Set when `--pair-token` was used on argv; the caller must print it. */
	deprecationWarning?: string;
}

function readFlagValue(argv: string[], index: number, flag: string): string {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith('--')) {
		throw new CliExitError(2, `${flag} requires a value`);
	}
	return value;
}

/**
 * Shared parser for `install` and `run`: both need `--hub-url` and exactly one
 * pair-token source. `--state-dir` defaults to `/var/lib/privos-app-cluster`.
 */
export function parseConnectArgs(argv: string[]): ConnectArgs {
	let hubUrl: string | undefined;
	let stateDir = DEFAULT_STATE_DIR;
	let pairTokenFile: string | undefined;
	let pairTokenStdin = false;
	let pairTokenArgv: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--hub-url':
				hubUrl = readFlagValue(argv, i, arg);
				i++;
				break;
			case '--state-dir':
				stateDir = readFlagValue(argv, i, arg);
				i++;
				break;
			case '--pair-token-file':
				pairTokenFile = readFlagValue(argv, i, arg);
				i++;
				break;
			case '--pair-token-stdin':
				pairTokenStdin = true;
				break;
			case '--pair-token':
				pairTokenArgv = readFlagValue(argv, i, arg);
				i++;
				break;
			default:
				throw new CliExitError(2, `unknown argument: ${arg}`);
		}
	}

	if (!hubUrl) throw new CliExitError(2, '--hub-url is required');
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(hubUrl);
	} catch {
		throw new CliExitError(2, `--hub-url is not a valid URL: ${hubUrl}`);
	}
	if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
		throw new CliExitError(2, `--hub-url must be http:// or https://, got: ${hubUrl}`);
	}
	if (!path.isAbsolute(stateDir)) {
		throw new CliExitError(2, `--state-dir must be an absolute path, got: ${stateDir}`);
	}

	const sources = [pairTokenFile !== undefined, pairTokenStdin, pairTokenArgv !== undefined].filter(Boolean).length;
	if (sources === 0) {
		throw new CliExitError(2, 'one of --pair-token-file, --pair-token-stdin, or --pair-token is required');
	}
	if (sources > 1) {
		throw new CliExitError(2, '--pair-token-file, --pair-token-stdin, and --pair-token are mutually exclusive');
	}

	const pairToken: PairTokenSource = pairTokenFile !== undefined
		? { kind: 'file', path: pairTokenFile }
		: pairTokenStdin
			? { kind: 'stdin' }
			: { kind: 'argv', token: pairTokenArgv as string };

	return {
		hubUrl,
		pairToken,
		stateDir,
		deprecationWarning: pairToken.kind === 'argv' ? PAIR_TOKEN_ARGV_DEPRECATION_WARNING : undefined,
	};
}

export interface UninstallArgs {
	purge: boolean;
}

export function parseUninstallArgs(argv: string[]): UninstallArgs {
	let purge = false;
	for (const arg of argv) {
		if (arg === '--purge') purge = true;
		else throw new CliExitError(2, `unknown argument: ${arg}`);
	}
	return { purge };
}

// ---------------------------------------------------------------------------
// Renderers (pure)
// ---------------------------------------------------------------------------

export interface EnvFileOptions {
	hubUrl: string;
	pairTokenFile: string;
	stateDir: string;
}

/**
 * The env file NEVER sets HOST, PORT, or JWT_SECRET — in tunnel mode the
 * service opens no listener, and the verification key comes from the paired
 * credential in the state dir (phase 3's `resolveClusterSecret()`), never
 * from config (wire-contracts.md (a) and (c)).
 */
export function renderEnvFile(opts: EnvFileOptions): string {
	return [
		`PRIVOS_HUB_URL=${opts.hubUrl}`,
		`PRIVOS_PAIR_TOKEN_FILE=${opts.pairTokenFile}`,
		`PRIVOS_STATE_DIR=${opts.stateDir}`,
		'CLUSTER_OPERATOR_ROUTES=off',
		'',
	].join('\n');
}

export interface SystemdUnitOptions {
	/** Absolute path of the node binary to run (`process.execPath`, re-resolved on `update`). */
	execPath: string;
	/** Absolute path of the globally-installed package's `dist/server.js`. */
	serverScript: string;
	envFile: string;
	stateDir: string;
}

export function renderSystemdUnit(opts: SystemdUnitOptions): string {
	return `[Unit]
Description=Privos App Cluster
After=network-online.target docker.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${SERVICE_USER}
ExecStart=${opts.execPath} ${opts.serverScript}
EnvironmentFile=${opts.envFile}
Restart=always
RestartSec=5
ReadWritePaths=${opts.stateDir}
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`;
}

// ---------------------------------------------------------------------------
// Command builders (pure) — provenance verification and the global install,
// asserted on directly by tests instead of by spying on a real npm process.
// ---------------------------------------------------------------------------

export interface ShellCommand {
	cmd: string;
	args: string[];
}

/**
 * Registry-side attestation check, run BEFORE the package ever reaches disk.
 * A version published without provenance (empty `dist.attestations`) refuses
 * the install — see the plan's supply-chain risk row.
 */
export function buildProvenanceCheckCommand(pkgSpec: string): ShellCommand {
	return { cmd: 'npm', args: ['view', pkgSpec, 'dist.attestations', '--json'] };
}

/** Never resolves through the npx cache — always a stable, versioned global install. */
export function buildGlobalInstallCommand(pkgSpec: string): ShellCommand {
	return { cmd: 'npm', args: ['install', '-g', pkgSpec, '--ignore-scripts'] };
}

export function buildNpmRootGlobalCommand(): ShellCommand {
	return { cmd: 'npm', args: ['root', '-g'] };
}

export function buildUseraddCommand(): ShellCommand {
	return { cmd: 'useradd', args: ['--system', '--no-create-home', '--groups', DOCKER_GROUP, SERVICE_USER] };
}

export function buildUserdelCommand(): ShellCommand {
	return { cmd: 'userdel', args: [SERVICE_USER] };
}

/** True when the registry reports at least one attestation for this exact version. */
export function provenanceCheckPassed(stdout: string): boolean {
	try {
		const parsed: unknown = JSON.parse(stdout);
		return Array.isArray(parsed) && parsed.length > 0;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Privileged executor — the only part that touches the real system. Never
// exercised by unit tests; `performInstall`/`performUpdate`/`performUninstall`
// take it as a parameter precisely so it can be swapped out in tests without
// running any of it here.
// ---------------------------------------------------------------------------

export interface PrivilegedExecutor {
	run(cmd: string, args: string[], input?: string): { code: number; stdout: string; stderr: string };
	fileExists(filePath: string): boolean;
	readFile(filePath: string): string | undefined;
	writeFile(filePath: string, contents: string, mode: number): void;
	chown(filePath: string, user: string): void;
	unlink(filePath: string): void;
	rm(dirPath: string): void;
	/** Reads the pair token off fd 0 when `--pair-token-stdin` was used. */
	readStdin(): string;
}

export const nodeExecutor: PrivilegedExecutor = {
	run(cmd, args, input) {
		try {
			const stdout = execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
			return { code: 0, stdout, stderr: '' };
		} catch (err) {
			const e = err as { status?: number; stdout?: string; stderr?: string; message: string };
			return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message };
		}
	},
	fileExists(filePath) {
		return fs.existsSync(filePath);
	},
	readStdin() {
		return fs.readFileSync(0, 'utf8').trim();
	},
	readFile(filePath) {
		try {
			return fs.readFileSync(filePath, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
			throw err;
		}
	},
	writeFile(filePath, contents, mode) {
		fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
		fs.writeFileSync(filePath, contents, { mode });
		fs.chmodSync(filePath, mode);
	},
	chown(filePath, user) {
		execFileSync('chown', [user, filePath]);
	},
	unlink(filePath) {
		try {
			fs.unlinkSync(filePath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
	},
	rm(dirPath) {
		fs.rmSync(dirPath, { recursive: true, force: true });
	},
};

function verifyProvenanceOrThrow(exec: PrivilegedExecutor, pkgSpec: string): void {
	const { cmd, args } = buildProvenanceCheckCommand(pkgSpec);
	const result = exec.run(cmd, args);
	if (result.code !== 0 || !provenanceCheckPassed(result.stdout)) {
		throw new CliExitError(
			1,
			`provenance attestation check failed for ${pkgSpec} — refusing to install. ` +
				(result.stderr || 'no signed provenance attestation found on the registry.'),
		);
	}
}

function resolveGlobalServerScript(exec: PrivilegedExecutor, version: string): string {
	const { cmd, args } = buildNpmRootGlobalCommand();
	const result = exec.run(cmd, args);
	if (result.code !== 0) throw new CliExitError(1, `failed to resolve npm global root: ${result.stderr}`);
	const globalRoot = result.stdout.trim();
	const serverScript = path.join(globalRoot, '@privos_ai', 'app-cluster', 'dist', 'server.js');
	if (!exec.fileExists(serverScript)) {
		throw new CliExitError(
			1,
			`expected ${serverScript} after installing ${PACKAGE_NAME}@${version}, but it is missing.`,
		);
	}
	return serverScript;
}

function resolvePairTokenValue(pairToken: PairTokenSource, exec: PrivilegedExecutor): string {
	if (pairToken.kind === 'argv') return pairToken.token;
	if (pairToken.kind === 'file') {
		const value = exec.readFile(pairToken.path);
		if (!value) throw new CliExitError(1, `--pair-token-file ${pairToken.path} is empty or unreadable`);
		return value.trim();
	}
	const value = exec.readStdin();
	if (!value) throw new CliExitError(1, '--pair-token-stdin was given but stdin was empty');
	return value;
}

export interface InstallOptions extends ConnectArgs {
	/** This package's own version (the one being installed globally). */
	version: string;
}

/** Idempotent: converges to the same unit/env state without re-pairing when nothing changed. */
export async function performInstall(opts: InstallOptions, exec: PrivilegedExecutor = nodeExecutor): Promise<{ alreadyInstalled: boolean }> {
	const pkgSpec = `${PACKAGE_NAME}@${opts.version}`;
	const alreadyInstalled = exec.fileExists(UNIT_FILE_PATH);

	verifyProvenanceOrThrow(exec, pkgSpec);
	const globalInstall = buildGlobalInstallCommand(pkgSpec);
	const install = exec.run(globalInstall.cmd, globalInstall.args);
	if (install.code !== 0) throw new CliExitError(1, `npm install -g ${pkgSpec} failed: ${install.stderr}`);
	const serverScript = resolveGlobalServerScript(exec, opts.version);

	if (!alreadyInstalled) {
		const userCheck = exec.run('id', ['-u', SERVICE_USER]);
		if (userCheck.code !== 0) {
			const { cmd, args } = buildUseraddCommand();
			const useradd = exec.run(cmd, args);
			if (useradd.code !== 0) throw new CliExitError(1, `useradd ${SERVICE_USER} failed: ${useradd.stderr}`);
		}
	}

	ensureStateDir(opts.stateDir);
	exec.chown(opts.stateDir, SERVICE_USER);
	const pairTokenValue = resolvePairTokenValue(opts.pairToken, exec);
	const pairTokenPath = writeStateFile(opts.stateDir, PAIR_TOKEN_FILENAME, pairTokenValue);
	exec.chown(pairTokenPath, SERVICE_USER);

	const envContents = renderEnvFile({ hubUrl: opts.hubUrl, pairTokenFile: pairTokenPath, stateDir: opts.stateDir });
	exec.writeFile(ENV_FILE_PATH, envContents, 0o600);
	exec.chown(ENV_FILE_PATH, SERVICE_USER);

	const unitContents = renderSystemdUnit({
		execPath: process.execPath,
		serverScript,
		envFile: ENV_FILE_PATH,
		stateDir: opts.stateDir,
	});
	exec.writeFile(UNIT_FILE_PATH, unitContents, 0o644);

	const reload = exec.run('systemctl', ['daemon-reload']);
	if (reload.code !== 0) throw new CliExitError(1, `systemctl daemon-reload failed: ${reload.stderr}`);
	const enable = exec.run('systemctl', ['enable', '--now', SERVICE_NAME]);
	if (enable.code !== 0) throw new CliExitError(1, `systemctl enable --now ${SERVICE_NAME} failed: ${enable.stderr}`);

	return { alreadyInstalled };
}

/** Reinstalls the global package with the same provenance + --ignore-scripts rules and restarts; never touches env/state. */
export async function performUpdate(version: string, exec: PrivilegedExecutor = nodeExecutor): Promise<void> {
	const pkgSpec = `${PACKAGE_NAME}@${version}`;
	verifyProvenanceOrThrow(exec, pkgSpec);
	const globalInstall = buildGlobalInstallCommand(pkgSpec);
	const install = exec.run(globalInstall.cmd, globalInstall.args);
	if (install.code !== 0) throw new CliExitError(1, `npm install -g ${pkgSpec} failed: ${install.stderr}`);
	const serverScript = resolveGlobalServerScript(exec, version);

	const existingUnit = exec.readFile(UNIT_FILE_PATH);
	if (!existingUnit) throw new CliExitError(1, `${SERVICE_NAME} is not installed — run "install" first`);
	const envFileMatch = /^EnvironmentFile=(.*)$/m.exec(existingUnit);
	const stateDirMatch = /^ReadWritePaths=(.*)$/m.exec(existingUnit);
	const envFile = envFileMatch?.[1] ?? ENV_FILE_PATH;
	const stateDir = stateDirMatch?.[1] ?? DEFAULT_STATE_DIR;

	const unitContents = renderSystemdUnit({ execPath: process.execPath, serverScript, envFile, stateDir });
	if (unitContents !== existingUnit) {
		exec.writeFile(UNIT_FILE_PATH, unitContents, 0o644);
		const reload = exec.run('systemctl', ['daemon-reload']);
		if (reload.code !== 0) throw new CliExitError(1, `systemctl daemon-reload failed: ${reload.stderr}`);
	}

	const restart = exec.run('systemctl', ['restart', SERVICE_NAME]);
	if (restart.code !== 0) throw new CliExitError(1, `systemctl restart ${SERVICE_NAME} failed: ${restart.stderr}`);
}

/** Stops/disables/removes the unit; with `purge` also removes the env file, state dir, and system user. */
export async function performUninstall(args: UninstallArgs, exec: PrivilegedExecutor = nodeExecutor): Promise<void> {
	exec.run('systemctl', ['disable', '--now', SERVICE_NAME]);
	exec.unlink(UNIT_FILE_PATH);
	exec.run('systemctl', ['daemon-reload']);

	if (!args.purge) return;

	const stateDir = /^PRIVOS_STATE_DIR=(.*)$/m.exec(exec.readFile(ENV_FILE_PATH) ?? '')?.[1] ?? DEFAULT_STATE_DIR;
	exec.unlink(ENV_FILE_PATH);
	exec.rm(stateDir);
	const { cmd, args: userdelArgs } = buildUserdelCommand();
	exec.run(cmd, userdelArgs);
}
