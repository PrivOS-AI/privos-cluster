import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { ArtifactStore, type ArtifactStoreDocker } from './artifact-store.js';
import { buildOciArchiveFixture } from './oci-archive-fixture.js';
import { ArtifactError, ArtifactStagingRefused } from './errors.js';

const tmpDirs: string[] = [];
function tmpStateDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-store-test-'));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

class FakeDocker implements ArtifactStoreDocker {
	loadCount = 0;
	images = new Map<string, { Id: string; Descriptor?: { mediaType: string; digest: string; size: number } }>();
	nextLoadResult: 'exact' | 'containerd-only' | 'missing' = 'exact';
	private pendingFixture: { configDigest: string; manifestDigest: string; manifestSizeBytes: number } | undefined;

	primeLoad(fixture: { configDigest: string; manifestDigest: string; manifestSizeBytes: number }): void {
		this.pendingFixture = fixture;
	}

	async loadArchive(): Promise<void> {
		this.loadCount++;
		if (!this.pendingFixture || this.nextLoadResult === 'missing') return;
		const { configDigest, manifestDigest, manifestSizeBytes } = this.pendingFixture;
		if (this.nextLoadResult === 'exact') {
			this.images.set(configDigest, { Id: configDigest });
		} else {
			this.images.set(manifestDigest, {
				Id: manifestDigest,
				Descriptor: { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: manifestDigest, size: manifestSizeBytes },
			});
		}
	}

	async inspectImage(reference: string) {
		return this.images.get(reference) ?? null;
	}
}

function writeArtifact(dir: string, bytes: Buffer): string {
	const filePath = path.join(dir, 'incoming.tar');
	fs.writeFileSync(filePath, bytes);
	return filePath;
}

test('stages a valid artifact: exactly one docker load, content-address pinned by config digest', async () => {
	const stateDir = tmpStateDir();
	const fixture = buildOciArchiveFixture();
	const docker = new FakeDocker();
	docker.primeLoad(fixture);
	const store = new ArtifactStore(stateDir, docker, 250_000_000, 3);

	const artifactPath = writeArtifact(stateDir, fixture.tar);
	const record = await store.stage({ path: artifactPath, sha256: fixture.digest, sizeBytes: fixture.tar.length });

	assert.equal(record.digest, fixture.digest);
	assert.equal(record.imageRef, fixture.configDigest);
	assert.equal(docker.loadCount, 1);
});

test('falls back to the manifest digest when only the containerd descriptor matches exactly', async () => {
	const stateDir = tmpStateDir();
	const fixture = buildOciArchiveFixture(['CONTAINERD_VARIANT=1']);
	const docker = new FakeDocker();
	docker.nextLoadResult = 'containerd-only';
	docker.primeLoad(fixture);
	const store = new ArtifactStore(stateDir, docker, 250_000_000, 3);

	const artifactPath = writeArtifact(stateDir, fixture.tar);
	const record = await store.stage({ path: artifactPath, sha256: fixture.digest, sizeBytes: fixture.tar.length });
	assert.equal(record.imageRef, fixture.manifestDigest);
});

test('refuses when Docker exposes no exact verified content address after load', async () => {
	const stateDir = tmpStateDir();
	const fixture = buildOciArchiveFixture(['NO_MATCH=1']);
	const docker = new FakeDocker();
	docker.nextLoadResult = 'missing';
	const store = new ArtifactStore(stateDir, docker, 250_000_000, 3);

	const artifactPath = writeArtifact(stateDir, fixture.tar);
	await assert.rejects(
		() => store.stage({ path: artifactPath, sha256: fixture.digest, sizeBytes: fixture.tar.length }),
		ArtifactError,
	);
});

test('staging the same digest twice performs exactly one docker load and returns the same record', async () => {
	const stateDir = tmpStateDir();
	const fixture = buildOciArchiveFixture(['REPEAT=1']);
	const docker = new FakeDocker();
	docker.primeLoad(fixture);
	const store = new ArtifactStore(stateDir, docker, 250_000_000, 3);

	const artifactPath1 = writeArtifact(stateDir, fixture.tar);
	const first = await store.stage({ path: artifactPath1, sha256: fixture.digest, sizeBytes: fixture.tar.length });

	// Simulate a fresh re-submission of the same bytes (a new temp file, as
	// the tunnel client would hand a second `stage` attempt after a retry).
	const artifactPath2 = writeArtifact(stateDir, fixture.tar);
	const second = await store.stage({ path: artifactPath2, sha256: fixture.digest, sizeBytes: fixture.tar.length });

	assert.deepEqual(first, second);
	assert.equal(docker.loadCount, 1);
});

test('a second ArtifactStore instance over the same state dir resolves the persisted record with zero docker calls', async () => {
	const stateDir = tmpStateDir();
	const fixture = buildOciArchiveFixture(['PERSIST=1']);
	const docker = new FakeDocker();
	docker.primeLoad(fixture);
	const store = new ArtifactStore(stateDir, docker, 250_000_000, 3);
	const artifactPath = writeArtifact(stateDir, fixture.tar);
	await store.stage({ path: artifactPath, sha256: fixture.digest, sizeBytes: fixture.tar.length });

	const reopened = new ArtifactStore(stateDir, docker, 250_000_000, 3);
	const resolved = reopened.resolve(fixture.digest);
	assert.ok(resolved);
	assert.equal(resolved!.imageRef, fixture.configDigest);
});

test('resolve returns null for a digest that was never staged', () => {
	const stateDir = tmpStateDir();
	const store = new ArtifactStore(stateDir, new FakeDocker(), 250_000_000, 3);
	assert.equal(store.resolve(`sha256:${'0'.repeat(64)}`), null);
});

test('refuses an artifact over the configured ceiling before touching the filesystem verifier', async () => {
	const stateDir = tmpStateDir();
	const store = new ArtifactStore(stateDir, new FakeDocker(), 250_000_000, 3);
	await assert.rejects(
		() => store.stage({ path: path.join(stateDir, 'does-not-exist.tar'), sha256: `sha256:${'a'.repeat(64)}`, sizeBytes: 250_000_001 }),
		ArtifactStagingRefused,
	);
});

test('refuses to stage when free space is below the configured multiplier of the declared size', async () => {
	const stateDir = tmpStateDir();
	const fixture = buildOciArchiveFixture(['SPACE=1']);
	const docker = new FakeDocker();
	docker.primeLoad(fixture);
	// A multiplier requiring far more free space than any test filesystem has.
	const store = new ArtifactStore(stateDir, docker, 250_000_000, 1_000_000_000);
	const artifactPath = writeArtifact(stateDir, fixture.tar);
	await assert.rejects(
		() => store.stage({ path: artifactPath, sha256: fixture.digest, sizeBytes: fixture.tar.length }),
		ArtifactStagingRefused,
	);
	assert.equal(docker.loadCount, 0);
});

test('a tar whose sha256 differs from the declared digest is rejected and never reaches Docker', async () => {
	const stateDir = tmpStateDir();
	const fixture = buildOciArchiveFixture(['MISMATCH=1']);
	const docker = new FakeDocker();
	docker.primeLoad(fixture);
	const store = new ArtifactStore(stateDir, docker, 250_000_000, 3);
	const artifactPath = writeArtifact(stateDir, fixture.tar);
	const wrongDigest = `sha256:${'f'.repeat(64)}`;
	await assert.rejects(
		() => store.stage({ path: artifactPath, sha256: wrongDigest, sizeBytes: fixture.tar.length }),
		ArtifactError,
	);
	assert.equal(docker.loadCount, 0);
	assert.equal(store.resolve(wrongDigest), null);
});
