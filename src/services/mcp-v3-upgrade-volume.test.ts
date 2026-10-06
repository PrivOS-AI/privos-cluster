import assert from 'node:assert/strict';
import test from 'node:test';

import { containerManager, imageManager } from '../docker/index.js';
import { canonicalJson, sha256 } from '../security/artifacts.js';
import { mountsForMcpV3Upgrade } from './lifecycle-service.js';

// An install made while the app was stateless has no volume; the upgrade to the
// first version that declares one must create and mount it, and nothing else.
const statefulManifest = { name: 'ai.acme.flow', version: '2.0.0', stateless: false, volumes: [{ name: 'data', mountPath: '/data' }] };
const digestOf = (manifest: unknown) => sha256(canonicalJson(manifest));

function stubImage(t: test.TestContext, manifest: unknown) {
	t.mock.method(imageManager, 'inspect', async () => ({
		dockerImageId: 'img', repoTag: 'r:t', repository: 'r', tag: 't', digest: null, sizeBytes: 0, created: 0,
		labels: manifest === undefined ? {} : { 'io.privos.mcp.manifest': JSON.stringify(manifest) },
	}));
	return t.mock.method(containerManager, 'ensureVolume', async () => undefined);
}

const base = { mounts: [], image: { name: 'registry/app', digest: `sha256:${'a'.repeat(64)}` }, workspaceId: 'ws1', containerId: 'c-123', multiReplica: false };

test('creates and mounts the data volume a new version declares', async (t) => {
	const ensure = stubImage(t, statefulManifest);
	const mounts = await mountsForMcpV3Upgrade({ ...base, manifestDigest: digestOf(statefulManifest) });
	assert.deepEqual(mounts, [{ dockerVolumeName: 'privos-ws-ws1-app-c-123-data', mountPath: '/data' }]);
	assert.equal(ensure.mock.callCount(), 1);
	assert.equal(ensure.mock.calls[0]!.arguments[0], 'privos-ws-ws1-app-c-123-data');
});

test('keeps existing mounts untouched', async (t) => {
	const ensure = stubImage(t, statefulManifest);
	const existing = [{ dockerVolumeName: 'privos-ws-ws1-app-c-123-data', mountPath: '/data' }];
	assert.deepEqual(await mountsForMcpV3Upgrade({ ...base, mounts: existing, manifestDigest: 'irrelevant' }), existing);
	assert.equal(ensure.mock.callCount(), 0);
});

test('a stateless or label-less version changes nothing and needs no digest match', async (t) => {
	const ensure = stubImage(t, { name: 'ai.acme.flow', stateless: true, volumes: [] });
	assert.deepEqual(await mountsForMcpV3Upgrade({ ...base, manifestDigest: 'does-not-match' }), []);
	t.mock.restoreAll();
	stubImage(t, undefined);
	assert.deepEqual(await mountsForMcpV3Upgrade({ ...base, manifestDigest: 'does-not-match' }), []);
	assert.equal(ensure.mock.callCount(), 0);
});

test('refuses a label that is not the signed target manifest', async (t) => {
	const ensure = stubImage(t, statefulManifest);
	await assert.rejects(
		mountsForMcpV3Upgrade({ ...base, manifestDigest: digestOf({ ...statefulManifest, version: '9.9.9' }) }),
		/mcp_v3_upgrade_manifest_digest_mismatch/,
	);
	assert.equal(ensure.mock.callCount(), 0);
});

test('refuses to add a volume to an app running more than one replica', async (t) => {
	const ensure = stubImage(t, statefulManifest);
	await assert.rejects(
		mountsForMcpV3Upgrade({ ...base, multiReplica: true, manifestDigest: digestOf(statefulManifest) }),
		/mcp_v3_upgrade_volume_requires_single_replica/,
	);
	assert.equal(ensure.mock.callCount(), 0);
});
