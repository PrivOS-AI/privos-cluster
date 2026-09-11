import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
	CREDENTIAL_FILENAME,
	checkStatePermissions,
	deleteStateFile,
	ensureStateDir,
	readStateFile,
	statePath,
	writeStateFile,
} from './state-dir.js';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privos-state-dir-test-'));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
	tmpDirs = [];
});

describe('ensureStateDir', () => {
	it('creates the dir at 0700', () => {
		const parent = makeTmpDir();
		const stateDir = path.join(parent, 'state');
		ensureStateDir(stateDir);
		assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
	});

	it('enforces 0700 on a pre-existing, looser directory', () => {
		const stateDir = makeTmpDir();
		fs.chmodSync(stateDir, 0o755);
		ensureStateDir(stateDir);
		assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
	});
});

describe('writeStateFile / readStateFile / deleteStateFile', () => {
	it('writes at 0600 and round-trips the contents', () => {
		const stateDir = makeTmpDir();
		const filePath = writeStateFile(stateDir, CREDENTIAL_FILENAME, 'secret-value');
		assert.equal(filePath, statePath(stateDir, CREDENTIAL_FILENAME));
		assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
		assert.equal(readStateFile(stateDir, CREDENTIAL_FILENAME), 'secret-value');
	});

	it('readStateFile returns undefined for a missing file, not an error', () => {
		const stateDir = makeTmpDir();
		assert.equal(readStateFile(stateDir, 'does-not-exist'), undefined);
	});

	it('deleteStateFile removes the file and is idempotent', () => {
		const stateDir = makeTmpDir();
		writeStateFile(stateDir, CREDENTIAL_FILENAME, 'value');
		deleteStateFile(stateDir, CREDENTIAL_FILENAME);
		assert.equal(readStateFile(stateDir, CREDENTIAL_FILENAME), undefined);
		assert.doesNotThrow(() => deleteStateFile(stateDir, CREDENTIAL_FILENAME));
	});
});

describe('checkStatePermissions', () => {
	it('reports ok for a correctly-permissioned dir and files', () => {
		const stateDir = makeTmpDir();
		ensureStateDir(stateDir);
		writeStateFile(stateDir, CREDENTIAL_FILENAME, 'value');
		const result = checkStatePermissions(stateDir);
		assert.deepEqual(result, { ok: true, issues: [] });
	});

	it('flags a state dir that is not 0700', () => {
		const stateDir = makeTmpDir();
		ensureStateDir(stateDir);
		fs.chmodSync(stateDir, 0o755);
		const result = checkStatePermissions(stateDir);
		assert.equal(result.ok, false);
		assert.ok(result.issues.some((issue) => issue.includes('0700')) || result.issues.length > 0);
	});

	it('flags a file that is not 0600', () => {
		const stateDir = makeTmpDir();
		const filePath = writeStateFile(stateDir, CREDENTIAL_FILENAME, 'value');
		fs.chmodSync(filePath, 0o644);
		const result = checkStatePermissions(stateDir);
		assert.equal(result.ok, false);
	});

	it('treats a missing state dir as ok (nothing to check yet)', () => {
		const parent = makeTmpDir();
		const result = checkStatePermissions(path.join(parent, 'never-created'));
		assert.deepEqual(result, { ok: true, issues: [] });
	});
});
