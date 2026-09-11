import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	CliExitError,
	DEFAULT_STATE_DIR,
	PAIR_TOKEN_ARGV_DEPRECATION_WARNING,
	assertLinuxServiceSupported,
	buildGlobalInstallCommand,
	buildProvenanceCheckCommand,
	buildUseraddCommand,
	parseConnectArgs,
	parseUninstallArgs,
	provenanceCheckPassed,
	renderEnvFile,
	renderSystemdUnit,
} from './service-install.js';

describe('assertLinuxServiceSupported', () => {
	it('proceeds silently on linux', () => {
		assert.doesNotThrow(() => assertLinuxServiceSupported('linux'));
	});

	it('refuses on darwin with exit code 2 and foreground run guidance', () => {
		try {
			assertLinuxServiceSupported('darwin');
			assert.fail('expected CliExitError');
		} catch (err) {
			assert.ok(err instanceof CliExitError);
			assert.equal(err.exitCode, 2);
			assert.match(err.message, /privos-app-cluster run --hub-url/);
			assert.match(err.message, /macOS/i);
		}
	});

	it('refuses on every other platform with exit code 2 and an unsupported-platform message', () => {
		try {
			assertLinuxServiceSupported('win32');
			assert.fail('expected CliExitError');
		} catch (err) {
			assert.ok(err instanceof CliExitError);
			assert.equal(err.exitCode, 2);
			assert.match(err.message, /unsupported platform/i);
			assert.doesNotMatch(err.message, /run --hub-url/);
		}
	});
});

describe('parseConnectArgs', () => {
	it('parses --hub-url with --pair-token-file and defaults the state dir', () => {
		const args = parseConnectArgs(['--hub-url', 'https://hub.example.com', '--pair-token-file', '/tmp/pair-token']);
		assert.equal(args.hubUrl, 'https://hub.example.com');
		assert.deepEqual(args.pairToken, { kind: 'file', path: '/tmp/pair-token' });
		assert.equal(args.stateDir, DEFAULT_STATE_DIR);
		assert.equal(args.deprecationWarning, undefined);
	});

	it('accepts --pair-token-stdin', () => {
		const args = parseConnectArgs(['--hub-url', 'http://hub.internal', '--pair-token-stdin']);
		assert.deepEqual(args.pairToken, { kind: 'stdin' });
	});

	it('accepts a custom --state-dir', () => {
		const args = parseConnectArgs([
			'--hub-url', 'http://hub.internal',
			'--pair-token-stdin',
			'--state-dir', '/opt/custom-state',
		]);
		assert.equal(args.stateDir, '/opt/custom-state');
	});

	it('--pair-token on argv still parses and carries the deprecation warning', () => {
		const args = parseConnectArgs(['--hub-url', 'http://hub.internal', '--pair-token', 'plain-text-token']);
		assert.deepEqual(args.pairToken, { kind: 'argv', token: 'plain-text-token' });
		assert.equal(args.deprecationWarning, PAIR_TOKEN_ARGV_DEPRECATION_WARNING);
	});

	it('--pair-token-file does not print the deprecation warning', () => {
		const args = parseConnectArgs(['--hub-url', 'http://hub.internal', '--pair-token-file', '/tmp/t']);
		assert.equal(args.deprecationWarning, undefined);
	});

	it('rejects a missing --hub-url', () => {
		assert.throws(
			() => parseConnectArgs(['--pair-token-stdin']),
			(err: unknown) => err instanceof CliExitError && err.exitCode === 2 && /--hub-url is required/.test(err.message),
		);
	});

	it('rejects a non-http(s) --hub-url', () => {
		assert.throws(
			() => parseConnectArgs(['--hub-url', 'ftp://hub.example.com', '--pair-token-stdin']),
			(err: unknown) => err instanceof CliExitError && /http:\/\/ or https:\/\//.test(err.message),
		);
	});

	it('rejects an invalid --hub-url', () => {
		assert.throws(
			() => parseConnectArgs(['--hub-url', 'not a url', '--pair-token-stdin']),
			(err: unknown) => err instanceof CliExitError && err.exitCode === 2,
		);
	});

	it('rejects zero pair-token sources', () => {
		assert.throws(
			() => parseConnectArgs(['--hub-url', 'http://hub.internal']),
			(err: unknown) => err instanceof CliExitError && /one of --pair-token/.test(err.message),
		);
	});

	it('rejects more than one pair-token source', () => {
		assert.throws(
			() => parseConnectArgs(['--hub-url', 'http://hub.internal', '--pair-token-stdin', '--pair-token-file', '/tmp/t']),
			(err: unknown) => err instanceof CliExitError && /mutually exclusive/.test(err.message),
		);
	});

	it('rejects a relative --state-dir', () => {
		assert.throws(
			() => parseConnectArgs(['--hub-url', 'http://hub.internal', '--pair-token-stdin', '--state-dir', 'relative/path']),
			(err: unknown) => err instanceof CliExitError && /absolute path/.test(err.message),
		);
	});

	it('rejects an unknown flag', () => {
		assert.throws(
			() => parseConnectArgs(['--hub-url', 'http://hub.internal', '--pair-token-stdin', '--bogus']),
			(err: unknown) => err instanceof CliExitError && /unknown argument/.test(err.message),
		);
	});

	it('rejects a flag missing its value', () => {
		assert.throws(
			() => parseConnectArgs(['--hub-url']),
			(err: unknown) => err instanceof CliExitError && /requires a value/.test(err.message),
		);
	});
});

describe('parseUninstallArgs', () => {
	it('defaults purge to false', () => {
		assert.deepEqual(parseUninstallArgs([]), { purge: false });
	});

	it('recognizes --purge', () => {
		assert.deepEqual(parseUninstallArgs(['--purge']), { purge: true });
	});

	it('rejects an unknown flag', () => {
		assert.throws(() => parseUninstallArgs(['--bogus']), (err: unknown) => err instanceof CliExitError);
	});
});

describe('renderEnvFile', () => {
	it('writes exactly the four allowed keys, never HOST/PORT/JWT_SECRET', () => {
		const contents = renderEnvFile({
			hubUrl: 'https://hub.example.com',
			pairTokenFile: '/var/lib/privos-app-cluster/pair-token',
			stateDir: '/var/lib/privos-app-cluster',
		});
		assert.match(contents, /^PRIVOS_HUB_URL=https:\/\/hub\.example\.com$/m);
		assert.match(contents, /^PRIVOS_PAIR_TOKEN_FILE=\/var\/lib\/privos-app-cluster\/pair-token$/m);
		assert.match(contents, /^PRIVOS_STATE_DIR=\/var\/lib\/privos-app-cluster$/m);
		assert.match(contents, /^CLUSTER_OPERATOR_ROUTES=off$/m);
		assert.doesNotMatch(contents, /HOST=/);
		assert.doesNotMatch(contents, /PORT=/);
		assert.doesNotMatch(contents, /JWT_SECRET/);
	});
});

describe('renderSystemdUnit', () => {
	const unit = renderSystemdUnit({
		execPath: '/usr/bin/node',
		serverScript: '/usr/lib/node_modules/@privos_ai/app-cluster/dist/server.js',
		envFile: '/etc/privos-app-cluster/app-cluster.env',
		stateDir: '/var/lib/privos-app-cluster',
	});

	it('sets Restart=always and RestartSec=5', () => {
		assert.match(unit, /^Restart=always$/m);
		assert.match(unit, /^RestartSec=5$/m);
	});

	it('points EnvironmentFile at the given env file', () => {
		assert.match(unit, /^EnvironmentFile=\/etc\/privos-app-cluster\/app-cluster\.env$/m);
	});

	it('scopes ReadWritePaths to the state dir', () => {
		assert.match(unit, /^ReadWritePaths=\/var\/lib\/privos-app-cluster$/m);
	});

	it('runs as the dedicated service user, never root', () => {
		assert.match(unit, /^User=privos-app-cluster$/m);
	});

	it('ExecStart runs the resolved node binary against the resolved server script', () => {
		assert.match(unit, /^ExecStart=\/usr\/bin\/node \/usr\/lib\/node_modules\/@privos_ai\/app-cluster\/dist\/server\.js$/m);
	});

	it('is enabled at boot', () => {
		assert.match(unit, /^WantedBy=multi-user\.target$/m);
	});
});

describe('buildGlobalInstallCommand', () => {
	it('always runs with --ignore-scripts', () => {
		const command = buildGlobalInstallCommand('@privos_ai/app-cluster@1.2.3');
		assert.equal(command.cmd, 'npm');
		assert.ok(command.args.includes('--ignore-scripts'));
		assert.ok(command.args.includes('@privos_ai/app-cluster@1.2.3'));
		assert.ok(command.args.includes('-g'));
	});
});

describe('buildProvenanceCheckCommand', () => {
	it('queries the registry before any install happens', () => {
		const command = buildProvenanceCheckCommand('@privos_ai/app-cluster@1.2.3');
		assert.equal(command.cmd, 'npm');
		assert.deepEqual(command.args, ['view', '@privos_ai/app-cluster@1.2.3', 'dist.attestations', '--json']);
	});
});

describe('provenanceCheckPassed', () => {
	it('passes when the registry reports at least one attestation', () => {
		assert.equal(provenanceCheckPassed('[{"predicateType":"https://slsa.dev/provenance/v1"}]'), true);
	});

	it('fails on an empty attestation list', () => {
		assert.equal(provenanceCheckPassed('[]'), false);
	});

	it('fails on unparseable output', () => {
		assert.equal(provenanceCheckPassed(''), false);
		assert.equal(provenanceCheckPassed('not json'), false);
	});
});

describe('buildUseraddCommand', () => {
	it('creates a system user with no home directory, in the docker group', () => {
		const command = buildUseraddCommand();
		assert.equal(command.cmd, 'useradd');
		assert.ok(command.args.includes('--system'));
		assert.ok(command.args.includes('--no-create-home'));
		assert.ok(command.args.includes('docker'));
		assert.ok(command.args.includes('privos-app-cluster'));
	});
});
