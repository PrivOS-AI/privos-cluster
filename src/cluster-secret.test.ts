import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { resolveClusterSecret, resolveClusterSecretFrom } from './cluster-secret.js';
import { CREDENTIAL_FILENAME, deleteStateFile, writeStateFile } from './state-dir.js';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privos-cluster-secret-test-'));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
	tmpDirs = [];
});

describe('resolveClusterSecretFrom — four secret-resolution states', () => {
	it('unpaired: no state-dir credential and no config secret resolves to none', () => {
		const stateDir = makeTmpDir();
		assert.equal(resolveClusterSecretFrom(stateDir, undefined), undefined);
	});

	it('paired/enabled: a state-dir credential wins, resolved per call (no restart needed)', () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, CREDENTIAL_FILENAME, 'paired-credential-value');
		assert.equal(resolveClusterSecretFrom(stateDir, undefined), 'paired-credential-value');
		// Also wins over a config secret when both are present (state-dir credential is authoritative).
		assert.equal(resolveClusterSecretFrom(stateDir, 'config-secret-0123456789'), 'paired-credential-value');
	});

	it('config-only: no state-dir credential falls back to the config secret (fleet/master HTTP path)', () => {
		const stateDir = makeTmpDir();
		assert.equal(resolveClusterSecretFrom(stateDir, 'config-secret-0123456789'), 'config-secret-0123456789');
	});

	it('revoked: a deleted state-dir credential with no config secret resolves to none again', () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, CREDENTIAL_FILENAME, 'paired-credential-value');
		deleteStateFile(stateDir, CREDENTIAL_FILENAME);
		assert.equal(resolveClusterSecretFrom(stateDir, undefined), undefined);
	});

	it('rotation on re-pair: a fresh credential written after boot is read on the very next call', () => {
		const stateDir = makeTmpDir();
		assert.equal(resolveClusterSecretFrom(stateDir, undefined), undefined);
		writeStateFile(stateDir, CREDENTIAL_FILENAME, 'rotated-credential-value');
		assert.equal(resolveClusterSecretFrom(stateDir, undefined), 'rotated-credential-value');
	});

	it('treats a whitespace-only credential file as absent, falling back to the config secret', () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, CREDENTIAL_FILENAME, '   \n');
		assert.equal(resolveClusterSecretFrom(stateDir, 'config-secret-0123456789'), 'config-secret-0123456789');
	});
});

describe('resolveClusterSecret — production entry point', () => {
	it('falls back to config.JWT_SECRET when the real state dir has no credential', () => {
		// The test process's real config.PRIVOS_STATE_DIR default
		// ('/var/lib/privos-app-cluster') has no credential file in CI/dev
		// sandboxes, so this exercises the config-only fallback against the
		// actual process env (JWT_SECRET is set by the npm test script).
		assert.equal(resolveClusterSecret(), 'test-secret-0123456789');
	});
});
