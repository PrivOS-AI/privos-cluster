import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { RuntimeLedger } from './ledger.js';
import { AffinityConflict, RuntimeUnavailable } from './errors.js';

const tmpDirs: string[] = [];
function tmpLedgerPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
	tmpDirs.push(dir);
	return path.join(dir, 'runtimes.json');
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function claimInput(overrides: Partial<Parameters<RuntimeLedger['claim']>[0]> = {}) {
	return {
		generationId: 'gen-1',
		installationId: 'inst-1',
		generationNumber: 1,
		requestHash: 'hash-1',
		requestJson: '{"a":1}',
		runtimeId: 'local-runtime-aaaa',
		artifactDigest: `sha256:${'a'.repeat(64)}`,
		imageManifestDigest: `sha256:${'b'.repeat(64)}`,
		imageConfigDigest: `sha256:${'c'.repeat(64)}`,
		containerSpecHash: 'spec-hash-1',
		now: 1000,
		...overrides,
	};
}

test('ledger file is created 0600 and its parent dir 0700', () => {
	const filePath = tmpLedgerPath();
	new RuntimeLedger(filePath);
	assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
	assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
});

test('claim is idempotent for identical affinity, conflicts on differing affinity', () => {
	const ledger = new RuntimeLedger(tmpLedgerPath());
	const first = ledger.claim(claimInput());
	const second = ledger.claim(claimInput());
	assert.deepEqual(first, second);
	assert.throws(() => ledger.claim(claimInput({ requestHash: 'different-hash' })), AffinityConflict);
});

test('full CLAIMED -> READY -> ACTIVATING -> ACTIVE happy path', () => {
	const ledger = new RuntimeLedger(tmpLedgerPath());
	const input = claimInput();
	ledger.claim(input);
	ledger.recordContainer(input.generationId, input.requestHash, 'container-1', 1001);
	const ready = ledger.markReady(input.generationId, input.requestHash, '{"ready":true}', '{"evidence":true}', 1002);
	assert.equal(ready.state, 'READY');

	const activating = ledger.claimActivation({
		runtimeId: input.runtimeId,
		requestHash: input.requestHash,
		activationRequestHash: 'act-hash-1',
		activationRequestJson: '{"activate":true}',
		activeContainerSpecHash: 'active-spec-1',
		now: 1003,
	});
	assert.equal(activating.state, 'ACTIVATING');

	ledger.recordActiveContainerReady({ runtimeId: input.runtimeId, activationRequestHash: 'act-hash-1', now: 1004 });
	const active = ledger.markActive({
		runtimeId: input.runtimeId,
		activationRequestHash: 'act-hash-1',
		activeResponseJson: '{"active":true}',
		activationEvidenceJson: '{"activeEvidence":true}',
		now: 1005,
	});
	assert.equal(active.state, 'ACTIVE');
	assert.equal(active.activeContainerReadyAt, 1004);
});

test('markReady before recordContainer is refused (no supervised container identity yet)', () => {
	const ledger = new RuntimeLedger(tmpLedgerPath());
	const input = claimInput();
	ledger.claim(input);
	assert.throws(() => ledger.markReady(input.generationId, input.requestHash, '{}', '{}', 1001), RuntimeUnavailable);
});

test('claimActivation before READY is refused', () => {
	const ledger = new RuntimeLedger(tmpLedgerPath());
	const input = claimInput();
	ledger.claim(input);
	assert.throws(
		() =>
			ledger.claimActivation({
				runtimeId: input.runtimeId,
				requestHash: input.requestHash,
				activationRequestHash: 'act-1',
				activationRequestJson: '{}',
				activeContainerSpecHash: 'spec',
				now: 1001,
			}),
		RuntimeUnavailable,
	);
});

test('repeated markActive with identical evidence replays instead of re-mutating', () => {
	const ledger = new RuntimeLedger(tmpLedgerPath());
	const input = claimInput();
	ledger.claim(input);
	ledger.recordContainer(input.generationId, input.requestHash, 'container-1', 1001);
	ledger.markReady(input.generationId, input.requestHash, '{"ready":true}', '{}', 1002);
	ledger.claimActivation({
		runtimeId: input.runtimeId,
		requestHash: input.requestHash,
		activationRequestHash: 'act-1',
		activationRequestJson: '{}',
		activeContainerSpecHash: 'spec',
		now: 1003,
	});
	ledger.recordActiveContainerReady({ runtimeId: input.runtimeId, activationRequestHash: 'act-1', now: 1004 });
	const first = ledger.markActive({
		runtimeId: input.runtimeId,
		activationRequestHash: 'act-1',
		activeResponseJson: '{"x":1}',
		activationEvidenceJson: '{"y":1}',
		now: 1005,
	});
	const second = ledger.markActive({
		runtimeId: input.runtimeId,
		activationRequestHash: 'act-1',
		activeResponseJson: '{"x":1}',
		activationEvidenceJson: '{"y":1}',
		now: 9999,
	});
	assert.deepEqual(first, second);
	assert.equal(second.updatedAt, 1005); // replay does not bump updatedAt
});

test('markActive with different evidence than what is persisted conflicts', () => {
	const ledger = new RuntimeLedger(tmpLedgerPath());
	const input = claimInput();
	ledger.claim(input);
	ledger.recordContainer(input.generationId, input.requestHash, 'container-1', 1001);
	ledger.markReady(input.generationId, input.requestHash, '{"ready":true}', '{}', 1002);
	ledger.claimActivation({
		runtimeId: input.runtimeId,
		requestHash: input.requestHash,
		activationRequestHash: 'act-1',
		activationRequestJson: '{}',
		activeContainerSpecHash: 'spec',
		now: 1003,
	});
	ledger.recordActiveContainerReady({ runtimeId: input.runtimeId, activationRequestHash: 'act-1', now: 1004 });
	ledger.markActive({
		runtimeId: input.runtimeId,
		activationRequestHash: 'act-1',
		activeResponseJson: '{"x":1}',
		activationEvidenceJson: '{"y":1}',
		now: 1005,
	});
	assert.throws(
		() =>
			ledger.markActive({
				runtimeId: input.runtimeId,
				activationRequestHash: 'act-1',
				activeResponseJson: '{"x":2}',
				activationEvidenceJson: '{"y":1}',
				now: 1006,
			}),
		AffinityConflict,
	);
});

test('deleteByRuntimeId removes the row and a repeat delete is idempotent (returns false)', () => {
	const ledger = new RuntimeLedger(tmpLedgerPath());
	const input = claimInput();
	ledger.claim(input);
	assert.equal(ledger.deleteByRuntimeId(input.runtimeId), true);
	assert.equal(ledger.getByRuntimeId(input.runtimeId), null);
	assert.equal(ledger.get(input.generationId), null);
	assert.equal(ledger.deleteByRuntimeId(input.runtimeId), false);
});

test('state survives a fresh RuntimeLedger instance over the same file (durability)', () => {
	const filePath = tmpLedgerPath();
	const first = new RuntimeLedger(filePath);
	first.claim(claimInput());
	const reopened = new RuntimeLedger(filePath);
	const record = reopened.get('gen-1');
	assert.ok(record);
	assert.equal(record!.state, 'CLAIMED');
});

test('withRuntimeLock serializes concurrent operations on the same runtimeId', async () => {
	const ledger = new RuntimeLedger(tmpLedgerPath());
	const order: string[] = [];
	const slow = ledger.withRuntimeLock('rt-1', async () => {
		order.push('slow-start');
		await new Promise((resolve) => setTimeout(resolve, 20));
		order.push('slow-end');
	});
	const fast = ledger.withRuntimeLock('rt-1', async () => {
		order.push('fast-start');
		order.push('fast-end');
	});
	await Promise.all([slow, fast]);
	assert.deepEqual(order, ['slow-start', 'slow-end', 'fast-start', 'fast-end']);
});

test('claim mints a provisional replicaId once and never re-mints it on replay', () => {
	const ledger = new RuntimeLedger(tmpLedgerPath());
	const first = ledger.claim(claimInput());
	const second = ledger.claim(claimInput());
	assert.match(first.replicaId, /^[0-9a-f-]{36}$/i);
	assert.equal(first.replicaId, second.replicaId);
	assert.equal(first.activeReplicaId, null);
});

test('claimActivation mints a final activeReplicaId once and replay never re-mints it', () => {
	const ledger = new RuntimeLedger(tmpLedgerPath());
	const input = claimInput();
	ledger.claim(input);
	ledger.recordContainer(input.generationId, input.requestHash, 'container-1', 1001);
	ledger.markReady(input.generationId, input.requestHash, '{"ready":true}', '{}', 1002);
	const activationInput = {
		runtimeId: input.runtimeId,
		requestHash: input.requestHash,
		activationRequestHash: 'act-1',
		activationRequestJson: '{}',
		activeContainerSpecHash: 'spec',
	};
	const first = ledger.claimActivation({ ...activationInput, now: 1003 });
	const second = ledger.claimActivation({ ...activationInput, now: 1004 });
	assert.match(first.activeReplicaId!, /^[0-9a-f-]{36}$/i);
	assert.equal(first.activeReplicaId, second.activeReplicaId);
	assert.notEqual(first.activeReplicaId, first.replicaId);
});

test('recordBrokerRegistered stamps the record; listActiveRecords/listKnownReplicaIds report the live state', () => {
	const ledger = new RuntimeLedger(tmpLedgerPath());
	const input = claimInput();
	const claimed = ledger.claim(input);
	assert.deepEqual(ledger.listActiveRecords(), []);
	assert.deepEqual(ledger.listKnownReplicaIds(), [claimed.replicaId]);

	ledger.recordContainer(input.generationId, input.requestHash, 'container-1', 1001);
	ledger.markReady(input.generationId, input.requestHash, '{"ready":true}', '{}', 1002);
	const activating = ledger.claimActivation({
		runtimeId: input.runtimeId,
		requestHash: input.requestHash,
		activationRequestHash: 'act-1',
		activationRequestJson: '{}',
		activeContainerSpecHash: 'spec',
		now: 1003,
	});
	ledger.recordActiveContainerReady({ runtimeId: input.runtimeId, activationRequestHash: 'act-1', now: 1004 });
	ledger.markActive({
		runtimeId: input.runtimeId,
		activationRequestHash: 'act-1',
		activeResponseJson: '{"x":1}',
		activationEvidenceJson: '{"y":1}',
		now: 1005,
	});
	assert.deepEqual(ledger.listKnownReplicaIds().sort(), [claimed.replicaId, activating.activeReplicaId!].sort());
	const active = ledger.listActiveRecords();
	assert.equal(active.length, 1);
	assert.equal(active[0]!.runtimeId, input.runtimeId);

	const registered = ledger.recordBrokerRegistered(input.runtimeId, 2000);
	assert.equal(registered.brokerRegisteredAt, 2000);
	assert.throws(() => ledger.recordBrokerRegistered('local-runtime-unknown', 2001), RuntimeUnavailable);
});

test('a pre-upgrade ledger record with no replicaId at all is backfilled on read, once, durably', () => {
	const filePath = tmpLedgerPath();
	const preUpgrade = {
		schemaVersion: 1,
		byRuntimeId: {
			'local-runtime-old': {
				generationId: 'gen-old',
				installationId: 'inst-old',
				generationNumber: 1,
				requestHash: 'hash-old',
				requestJson: '{}',
				runtimeId: 'local-runtime-old',
				artifactDigest: `sha256:${'a'.repeat(64)}`,
				imageManifestDigest: `sha256:${'b'.repeat(64)}`,
				imageConfigDigest: `sha256:${'c'.repeat(64)}`,
				containerSpecHash: 'spec-old',
				containerId: 'container-old',
				state: 'ACTIVE',
				readyResponseJson: '{"ready":true}',
				driverEvidenceJson: '{}',
				activationRequestHash: 'act-old',
				activationRequestJson: '{}',
				activeContainerSpecHash: 'active-spec-old',
				activationClaimedAt: 1000,
				activeContainerReadyAt: 1000,
				activeResponseJson: '{"active":true}',
				activationEvidenceJson: '{}',
				createdAt: 1000,
				updatedAt: 1000,
				activeReplicaId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
				brokerRegisteredAt: null,
				// no `replicaId` at all — the pre-upgrade shape.
			},
		},
		generationToRuntimeId: { 'gen-old': 'local-runtime-old' },
	};
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(filePath, JSON.stringify(preUpgrade), { mode: 0o600 });

	const ledger = new RuntimeLedger(filePath);
	const first = ledger.getByRuntimeId('local-runtime-old');
	assert.match(first!.replicaId, /^[0-9a-f-]{36}$/i);

	const second = ledger.getByRuntimeId('local-runtime-old');
	assert.equal(second!.replicaId, first!.replicaId, 'a re-read must never re-mint the backfilled id');

	const reopened = new RuntimeLedger(filePath);
	assert.equal(reopened.getByRuntimeId('local-runtime-old')!.replicaId, first!.replicaId, 'the backfill was persisted, not just cached in memory');
});

test('withRuntimeLock does not serialize operations on different runtimeIds', async () => {
	const ledger = new RuntimeLedger(tmpLedgerPath());
	const order: string[] = [];
	let releaseA: () => void = () => {};
	const gate = new Promise<void>((resolve) => { releaseA = resolve; });
	const a = ledger.withRuntimeLock('rt-a', async () => {
		order.push('a-start');
		await gate;
		order.push('a-end');
	});
	const b = ledger.withRuntimeLock('rt-b', async () => {
		order.push('b-start');
		order.push('b-end');
	});
	await b;
	assert.deepEqual(order, ['a-start', 'b-start', 'b-end']);
	releaseA();
	await a;
	assert.deepEqual(order, ['a-start', 'b-start', 'b-end', 'a-end']);
});
