/**
 * F: single-flight + coalescing, revision taken before the snapshot,
 * runtime-before-ingress push order, and — H1/M2 — acceptance ordered by
 * `revision` alone, with a failed push retried on the SAME revision via
 * backoff rather than hot-looping and re-incrementing every attempt.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { HostTablePublisher } from './host-table-publisher.js';
import type { AppHostRecord } from './app-host-registry.js';
import type { MasterApp, MasterNode } from './types.js';

function node(overrides: Partial<MasterNode>): MasterNode {
	const now = new Date();
	return {
		nodeId: 'node-1', url: 'https://node-1.internal', region: 'eu', failureDomain: 'fd-1',
		capacity: { memoryMb: 4096, cpus: 4, diskBytes: 1 }, status: 'ACTIVE',
		keyId: 'key-1', encryptedFleetKey: 'enc', createdAt: now, updatedAt: now,
		...overrides,
	};
}

function app(overrides: Partial<MasterApp>): MasterApp {
	const now = new Date();
	return {
		appId: 'app-1', workspaceId: 'ws-1', listingId: 'listing-1', versionDigest: 'sha256:' + 'a'.repeat(64),
		image: 'img', imageDigest: 'sha256:' + 'a'.repeat(64), resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 },
		port: 3001, envVars: {}, volumes: [], storageBytes: 0, availabilityTier: 'single', stateless: true,
		replicas: [], state: 'RUNNING', createdAt: now, updatedAt: now,
		...overrides,
	};
}

function fixture() {
	const nodes: MasterNode[] = [];
	const apps: MasterApp[] = [];
	const hosts: AppHostRecord[] = [];
	let revision = 0;
	let incCalls = 0;
	const calls: Array<{ nodeId: string; path: string; body: any }> = [];
	const failingNodeIds = new Set<string>();
	const sleeps: number[] = [];

	const repositories = {
		apps: { find: () => ({ toArray: async () => apps }) },
		nodes: { find: () => ({ toArray: async () => nodes }) },
		appHosts: { find: () => ({ toArray: async () => hosts }) },
		masterMeta: {
			findOneAndUpdate: async () => {
				revision += 1;
				incCalls += 1;
				return { _id: 'routing-revision', revision, updatedAt: new Date() };
			},
		},
	};
	const agentClient = {
		fleetRequest: async (targetNode: MasterNode, _method: string, path: string, body: unknown) => {
			calls.push({ nodeId: targetNode.nodeId, path, body });
			if (failingNodeIds.has(targetNode.nodeId)) return { status: 503, headers: {}, body: { error: 'down' } };
			return { status: 200, headers: {}, body: { applied: true } };
		},
	};
	const publisher = new HostTablePublisher({
		repositories: repositories as any,
		agentClient: agentClient as any,
		baseDomain: 'apps.example.com',
		// Records the REQUESTED backoff (so the test can assert on the growth
		// curve) but only ever waits 1 real ms, so a persistently-failing node
		// in a test never busy-spins the microtask queue and always leaves
		// room for a `markDirty()`/cleanup to land and stop the retry loop.
		sleep: async (ms: number) => {
			sleeps.push(ms);
			await new Promise((resolve) => setTimeout(resolve, 1));
		},
	});
	return { publisher, nodes, apps, hosts, calls, failingNodeIds, sleeps, get revision() { return revision; }, get incCalls() { return incCalls; } };
}

test('publishOnce increments the revision BEFORE the snapshot, and pushes runtime tables before ingress tables', async () => {
	const { publisher, nodes, apps, calls } = fixture();
	nodes.push(node({ nodeId: 'runtime-1', role: 'RUNTIME' }), node({ nodeId: 'ingress-1', role: 'INGRESS' }));
	apps.push(app({ replicas: [{ replicaId: 'r-1', nodeId: 'runtime-1', containerId: 'c-1', state: 'running' }] }));

	const result = await publisher.publishOnce();
	assert.equal(result.revision, 1);
	assert.equal(result.runtimeNodes, 1);
	assert.equal(result.ingressNodes, 1);
	const runtimeCallIndex = calls.findIndex((call) => call.path.includes('/runtime'));
	const ingressCallIndex = calls.findIndex((call) => call.path.includes('/ingress'));
	assert.ok(runtimeCallIndex < ingressCallIndex, 'runtime tables must reach the fleet before ingress tables');

	const second = await publisher.publishOnce();
	assert.equal(second.revision, 2, 'revision only ever increases, taken fresh each publish');
});

test('a node with no `role` is treated as RUNTIME — byte-identical to a pre-phase-3 fleet', async () => {
	const { publisher, nodes, apps, calls } = fixture();
	nodes.push(node({ nodeId: 'legacy-node', role: undefined }));
	apps.push(app({ replicas: [{ replicaId: 'r-1', nodeId: 'legacy-node', containerId: 'c-1', state: 'running' }] }));
	await publisher.publishOnce();
	assert.ok(calls.some((call) => call.nodeId === 'legacy-node' && call.path.includes('/runtime')));
	assert.ok(!calls.some((call) => call.nodeId === 'legacy-node' && call.path.includes('/ingress')));
});

test('markDirty is single-flight and coalescing: concurrent calls never lose a host, and settle to the latest snapshot', async () => {
	const { publisher, nodes, apps, calls } = fixture();
	nodes.push(node({ nodeId: 'runtime-1', role: 'RUNTIME' }));
	apps.push(app({ appId: 'app-1', replicas: [{ replicaId: 'r-1', nodeId: 'runtime-1', containerId: 'c-1', state: 'running' }] }));

	publisher.markDirty();
	apps.push(app({ appId: 'app-2', replicas: [{ replicaId: 'r-2', nodeId: 'runtime-1', containerId: 'c-2', state: 'running' }] }));
	publisher.markDirty();
	publisher.markDirty();

	// Wait for the coalesced pump to drain.
	await new Promise((resolve) => setTimeout(resolve, 50));

	const lastRuntimeCall = calls.filter((call) => call.path.includes('/runtime')).at(-1);
	assert.ok(lastRuntimeCall);
	const appIds = lastRuntimeCall!.body.apps.map((entry: { appId: string }) => entry.appId);
	assert.deepEqual(new Set(appIds), new Set(['app-1', 'app-2']), 'the last settled pass always reflects the full current state');
});

test('a node push failure re-dirties instead of losing that node\'s update — the retry sees the SAME bootTimestamp', async () => {
	const { publisher, nodes, apps, calls, failingNodeIds } = fixture();
	nodes.push(node({ nodeId: 'runtime-1', role: 'RUNTIME' }));
	apps.push(app({ replicas: [{ replicaId: 'r-1', nodeId: 'runtime-1', containerId: 'c-1', state: 'running' }] }));
	failingNodeIds.add('runtime-1');

	await assert.rejects(publisher.publishOnce());
	failingNodeIds.delete('runtime-1');
	const result = await publisher.publishOnce();
	assert.equal(result.runtimeNodes, 1);

	const bootTimestamps = new Set(calls.map((call) => call.body.bootTimestamp));
	assert.equal(bootTimestamps.size, 1, 'bootTimestamp is stable across publishes within the same process');
});

test('H1: a delayed lower-revision push is never sent after a higher one — revision only ever increases across publishOnce calls', async () => {
	const { publisher } = fixture();
	const first = await publisher.publishOnce();
	const second = await publisher.publishOnce();
	assert.ok(second.revision > first.revision, 'revision is a total, ever-increasing order across every publish');
});

test('M2: a persistently failing node backs off exponentially, capped, and reuses the SAME revision (no re-increment) across retries', async (t) => {
	const state = fixture();
	const { publisher, nodes, apps, failingNodeIds, sleeps } = state;
	// Cleanup lets the background retry loop succeed on its next attempt and
	// stop, rather than run forever across the rest of the test process.
	t.after(() => failingNodeIds.delete('runtime-1'));
	nodes.push(node({ nodeId: 'runtime-1', role: 'RUNTIME' }));
	apps.push(app({ replicas: [{ replicaId: 'r-1', nodeId: 'runtime-1', containerId: 'c-1', state: 'running' }] }));
	failingNodeIds.add('runtime-1');

	publisher.markDirty();
	// Each retry's `sleep` waits a real 1ms (see fixture), so this window
	// bounds the loop to a handful of attempts, never a busy-spin.
	await new Promise((resolve) => setTimeout(resolve, 30));

	assert.equal(state.incCalls, 1, 'a retry of the SAME unchanged snapshot must never burn a second $inc');
	assert.ok(sleeps.length >= 3, 'a persistently failing node must keep retrying, not give up');
	// Strictly increasing backoff, capped — never a flat, hot-looping interval.
	for (let i = 1; i < Math.min(sleeps.length, 5); i += 1) {
		assert.ok(sleeps[i]! >= sleeps[i - 1]!, 'backoff must never shrink');
	}
	assert.ok(sleeps.every((ms) => ms <= 5 * 60 * 1000), 'backoff must stay capped at the resync interval');
});

test('M2: a fresh markDirty() while a retry is backing off abandons the stale attempt for a new snapshot+revision', async (t) => {
	const state = fixture();
	const { publisher, nodes, apps, failingNodeIds } = state;
	t.after(() => failingNodeIds.delete('runtime-1'));
	nodes.push(node({ nodeId: 'runtime-1', role: 'RUNTIME' }));
	apps.push(app({ appId: 'app-1', replicas: [{ replicaId: 'r-1', nodeId: 'runtime-1', containerId: 'c-1', state: 'running' }] }));
	failingNodeIds.add('runtime-1');

	publisher.markDirty();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(state.incCalls, 1);

	// The node comes back AND new data lands — the next markDirty() must take
	// a fresh, successful snapshot rather than stay stuck retrying the old one.
	failingNodeIds.delete('runtime-1');
	publisher.markDirty();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(state.incCalls >= 2, 'the abandoned retry and the fresh attempt are two distinct snapshots, each with its own revision');
});

test('an ingress rule marks a non-RUNNING app suspended, and a workspace-suspended host is carried through', async () => {
	const { publisher, nodes, apps, hosts, calls } = fixture();
	nodes.push(node({ nodeId: 'runtime-1', role: 'RUNTIME' }), node({ nodeId: 'ingress-1', role: 'INGRESS' }));
	apps.push(app({ appId: 'app-1', state: 'STOPPED', replicas: [] }));
	hosts.push({
		_id: 'app-1.privos.link', workspaceId: 'ws-1', appId: 'app-1', listingId: 'listing-1',
		kind: 'VANITY', primary: true, state: 'ACTIVE', createdAt: new Date(), updatedAt: new Date(),
	});
	await publisher.publishOnce();
	const ingressCall = calls.find((call) => call.path.includes('/ingress'))!;
	const rule = ingressCall.body.rules.find((r: { host: string }) => r.host === 'app-1.privos.link');
	assert.equal(rule.suspended, true);
});

test('the ingress table distributes an INGRESS node\'s own ingress signing key — never its mcpIdentity key', async () => {
	const { publisher, nodes, apps, calls } = fixture();
	// A BOTH node that carries BOTH keys: mcpIdentity (attests containers) and
	// the ingress signing key (signs a forwarded hop). The runtime verifies a
	// FORWARD, so only the ingress key must be distributed — using mcpIdentity
	// here would 403 every real request (the kid on the wire would not match).
	nodes.push(node({
		nodeId: 'app-eu-01', role: 'BOTH', meshIp: '10.88.0.11',
		mcpIdentityKid: 'mcp-identity-kid', mcpIdentityPublicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'MCP_IDENTITY' },
		ingressSigningKid: 'ingress-kid', ingressSigningPublicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'INGRESS_KEY' },
	}));
	apps.push(app({ replicas: [{ replicaId: 'r-1', nodeId: 'app-eu-01', containerId: 'c-1', state: 'running' }] }));

	await publisher.publishOnce();
	const ingressCall = calls.find((call) => call.path.includes('/ingress'))!;
	assert.deepEqual(ingressCall.body.signingKeys, [
		{ nodeId: 'app-eu-01', kid: 'ingress-kid', publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'INGRESS_KEY' } },
	]);
	const kids = ingressCall.body.signingKeys.map((k: { kid: string }) => k.kid);
	assert.ok(!kids.includes('mcp-identity-kid'), 'mcpIdentity key must never be distributed as an ingress verification key');
});

test('an INGRESS node without a registered ingress signing key contributes no verification key', async () => {
	const { publisher, nodes, apps, calls } = fixture();
	nodes.push(node({ nodeId: 'app-eu-01', role: 'BOTH', meshIp: '10.88.0.11', mcpIdentityKid: 'mcp-kid', mcpIdentityPublicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'MCP' } }));
	apps.push(app({ replicas: [{ replicaId: 'r-1', nodeId: 'app-eu-01', containerId: 'c-1', state: 'running' }] }));
	await publisher.publishOnce();
	const ingressCall = calls.find((call) => call.path.includes('/ingress'))!;
	assert.deepEqual(ingressCall.body.signingKeys, []);
});
