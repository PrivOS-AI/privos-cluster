import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { verifyOciArchive } from './oci-archive.js';
import { buildOciArchiveFixture } from './oci-archive-fixture.js';
import { ArtifactError } from './errors.js';

const tmpDirs: string[] = [];
function tmpFile(bytes: Buffer): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-archive-test-'));
	tmpDirs.push(dir);
	const filePath = path.join(dir, 'artifact.tar');
	fs.writeFileSync(filePath, bytes);
	return filePath;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('verifies a well-formed single-layer OCI archive', async () => {
	const fixture = buildOciArchiveFixture();
	const filePath = tmpFile(fixture.tar);
	const result = await verifyOciArchive(filePath, fixture.digest, fixture.tar.length, 250_000_000);
	assert.equal(result.artifactDigest, fixture.digest);
	assert.equal(result.manifestDigest, fixture.manifestDigest);
	assert.equal(result.configDigest, fixture.configDigest);
	assert.equal(result.manifestSizeBytes, fixture.manifestSizeBytes);
});

test('rejects a whole-archive digest mismatch and leaves the caller to discard the file', async () => {
	const fixture = buildOciArchiveFixture();
	const filePath = tmpFile(fixture.tar);
	const wrongDigest = `sha256:${'0'.repeat(64)}`;
	await assert.rejects(() => verifyOciArchive(filePath, wrongDigest, fixture.tar.length, 250_000_000), ArtifactError);
});

test('rejects a declared size that does not match the file on disk', async () => {
	const fixture = buildOciArchiveFixture();
	const filePath = tmpFile(fixture.tar);
	await assert.rejects(() => verifyOciArchive(filePath, fixture.digest, fixture.tar.length + 1, 250_000_000), ArtifactError);
});

test('rejects a tampered blob whose bytes no longer match its OCI descriptor digest', async () => {
	const fixture = buildOciArchiveFixture();
	const tampered = Buffer.from(fixture.tar);
	// Flip one byte inside the config blob's content region (well past the
	// headers, inside the padded data of the 3rd+ tar entries).
	const flipOffset = 512 * 3 + 50;
	tampered[flipOffset] = tampered[flipOffset]! ^ 0xff;
	const filePath = tmpFile(tampered);
	const recomputedDigest = `sha256:${createHash('sha256').update(tampered).digest('hex')}`;
	await assert.rejects(() => verifyOciArchive(filePath, recomputedDigest, tampered.length, 250_000_000), ArtifactError);
});

function ustarHeader(name: string, size: number): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, 'utf8');
	header.write('0000644\0', 100, 'ascii');
	header.write('0000000\0', 108, 'ascii');
	header.write('0000000\0', 116, 'ascii');
	header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
	header.write('00000000000\0', 136, 'ascii');
	header.write('        ', 148, 'ascii');
	header.write('0', 156, 'ascii');
	header.write('ustar\0', 257, 'ascii');
	header.write('00', 263, 'ascii');
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
	return header;
}

test('rejects an archive containing an unexpected extra file not referenced by the manifest', async () => {
	const fixture = buildOciArchiveFixture();
	const content = Buffer.from('unexpected');
	const extraEntry = Buffer.concat([ustarHeader('extra-file.txt', content.length), content, Buffer.alloc(512 - content.length)]);
	// Splice the extra entry in before the two trailing zero end-blocks.
	const withExtra = Buffer.concat([fixture.tar.subarray(0, fixture.tar.length - 1024), extraEntry, Buffer.alloc(1024)]);
	const digest = `sha256:${createHash('sha256').update(withExtra).digest('hex')}`;
	const filePath = tmpFile(withExtra);
	await assert.rejects(() => verifyOciArchive(filePath, digest, withExtra.length, 250_000_000), ArtifactError);
});
