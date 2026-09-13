import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { ArtifactStore, type ArtifactStoreDocker, createDockerArtifactStoreDocker } from './artifact-store.js';
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

	removedRefs: string[] = [];
	/** Set to simulate Docker refusing removal (409: a container still references the image). */
	refuseRemoval = false;

	async removeImage(reference: string): Promise<void> {
		// Mirrors what `createDockerArtifactStoreDocker` raises for Docker's 409
		// ("image is referenced by a running container") — the seam this fake stands in for
		// is the post-wrap one, so it must fail the same way.
		if (this.refuseRemoval) throw new ArtifactError('docker image removal failed: conflict: image is referenced by a container');
		this.removedRefs.push(reference);
		this.images.delete(reference);
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

test('remove erases the staged image and its index entry, proven by re-inspection', async () => {
	const stateDir = tmpStateDir();
	const fixture = buildOciArchiveFixture(['REMOVE=1']);
	const docker = new FakeDocker();
	docker.primeLoad(fixture);
	const store = new ArtifactStore(stateDir, docker, 250_000_000, 3);
	await store.stage({ path: writeArtifact(stateDir, fixture.tar), sha256: fixture.digest, sizeBytes: fixture.tar.length });
	assert.ok(store.resolve(fixture.digest), 'precondition: the artifact is staged');

	const absent = await store.remove(fixture.digest);

	assert.deepEqual({ digest: absent.digest, state: absent.state, removed: absent.removed }, { digest: fixture.digest, state: 'ABSENT', removed: true });
	assert.deepEqual(docker.removedRefs, [fixture.configDigest], 'the proven content address is what gets removed');
	assert.equal(store.resolve(fixture.digest), null, 'the index entry must not survive removal');
	assert.equal(await docker.inspectImage(fixture.configDigest), null, 'the image must be gone from Docker');
});

test('remove is idempotent: a digest that was never staged reports ABSENT instead of failing', async () => {
	const stateDir = tmpStateDir();
	const docker = new FakeDocker();
	const store = new ArtifactStore(stateDir, docker, 250_000_000, 3);

	const absent = await store.remove(`sha256:${'0'.repeat(64)}`);

	assert.equal(absent.state, 'ABSENT');
	assert.equal(absent.removed, false, 'nothing was removed, and that is not a failure');
	assert.deepEqual(docker.removedRefs, [], 'an unknown digest must not reach Docker at all');
});

test('remove refuses to report erasure while a container still pins the image', async () => {
	const stateDir = tmpStateDir();
	const fixture = buildOciArchiveFixture(['PINNED=1']);
	const docker = new FakeDocker();
	docker.primeLoad(fixture);
	const store = new ArtifactStore(stateDir, docker, 250_000_000, 3);
	await store.stage({ path: writeArtifact(stateDir, fixture.tar), sha256: fixture.digest, sizeBytes: fixture.tar.length });
	docker.refuseRemoval = true;

	await assert.rejects(store.remove(fixture.digest), /docker image removal failed/);
	assert.ok(store.resolve(fixture.digest), 'the record must survive a refused removal so the uninstall can retry');
});

// The 404/409 mapping lives in the production adapter, not in ArtifactStore, so
// the fake above can never exercise it. This drives the REAL adapter over a
// stub dockerode: 404 must be success (absence is the goal), anything else must
// surface rather than be swallowed into a false erasure claim.
test('the production Docker adapter treats a missing image as removed and surfaces an in-use conflict', async () => {
	const calls: string[] = [];
	const fakeDockerode = (statusCode: number | undefined) =>
		({
			getImage(reference: string) {
				calls.push(reference);
				return {
					async remove() {
						if (statusCode === undefined) return;
						throw Object.assign(new Error('docker says no'), { statusCode });
					},
				};
			},
		}) as never;

	await createDockerArtifactStoreDocker(fakeDockerode(404), {} as never).removeImage('sha256:missing');
	await createDockerArtifactStoreDocker(fakeDockerode(undefined), {} as never).removeImage('sha256:present');
	await assert.rejects(
		createDockerArtifactStoreDocker(fakeDockerode(409), {} as never).removeImage('sha256:inuse'),
		(err: Error) => err instanceof ArtifactError && /docker image removal failed/.test(err.message),
	);
	assert.deepEqual(calls, ['sha256:missing', 'sha256:present', 'sha256:inuse']);
});
