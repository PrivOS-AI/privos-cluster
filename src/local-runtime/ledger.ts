/**
 * Crash-safe local-runtime ledger — TS port of the state machine in
 * `infra/local-runtime-driver/privos_local_runtime_driver/ledger.py`, backed
 * by a single 0600 JSON file instead of sqlite (phase spec: "a 0600 JSON
 * ledger in the state dir keyed by generation_id/runtime_id", not a
 * database). States: `CLAIMED -> READY -> ACTIVATING -> ACTIVE`; `REMOVE`
 * deletes the row outright (mirrors `delete_by_runtime_id` — ABSENT is a
 * derived response, never a stored state, which is what makes a repeated
 * REMOVE idempotent once the row is already gone).
 *
 * Concurrency: every public method takes an async per-`runtimeId` lock
 * (`withRuntimeLock`). `runtimeId` is a deterministic pure function of the
 * full request (see `runtime-service.ts`'s `computeRuntimeId`), so two
 * different `generation_id`s never collide on the same lock key and locking
 * by `runtimeId` alone also serializes per-`generation_id` — the two-key
 * requirement in the phase spec collapses to one because of that
 * determinism. This is in-process only (one App Cluster runs one process;
 * cross-process races only happen Hub-side across an HA failover, which the
 * generation/digest/hash idempotency below — not this lock — makes safe).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AffinityConflict, RuntimeUnavailable } from './errors.js';

export type RuntimeState = 'CLAIMED' | 'READY' | 'ACTIVATING' | 'ACTIVE';

export interface RuntimeRecord {
	generationId: string;
	installationId: string;
	generationNumber: number;
	requestHash: string;
	requestJson: string;
	runtimeId: string;
	artifactDigest: string;
	imageManifestDigest: string;
	imageConfigDigest: string;
	containerSpecHash: string;
	containerId: string | null;
	state: RuntimeState;
	readyResponseJson: string | null;
	driverEvidenceJson: string | null;
	activationRequestHash: string | null;
	activationRequestJson: string | null;
	activeContainerSpecHash: string | null;
	activationClaimedAt: number | null;
	activeContainerReadyAt: number | null;
	activeResponseJson: string | null;
	activationEvidenceJson: string | null;
	createdAt: number;
	updatedAt: number;
	/**
	 * The MANAGED identity broker's replica id for the PREACTIVATION (provisioning)
	 * container — minted once, durably, the first time this generation is claimed
	 * (never re-minted on replay). The finalized ACTIVATE-phase replica gets its
	 * own id (`activeReplicaId`) so the two broker directories are never conflated.
	 */
	replicaId: string;
	/** Minted once, durably, in `claimActivation` — never re-minted on a retried activation. `null` until activation is first claimed. */
	activeReplicaId: string | null;
	/** Last time this process (re)registered the broker binding for the current phase's replica — observability only, never read back for correctness. */
	brokerRegisteredAt: number | null;
}

interface LedgerFile {
	schemaVersion: 1;
	byRuntimeId: Record<string, RuntimeRecord>;
	generationToRuntimeId: Record<string, string>;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function emptyLedger(): LedgerFile {
	return { schemaVersion: 1, byRuntimeId: {}, generationToRuntimeId: {} };
}

/** Simple async mutex keyed by string — one FIFO chain per key, released on settle (success or throw). */
class KeyedMutex {
	private readonly chains = new Map<string, Promise<void>>();

	async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
		const previous = this.chains.get(key) ?? Promise.resolve();
		let release: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		this.chains.set(key, previous.then(() => gate));
		await previous;
		try {
			return await fn();
		} finally {
			release!();
			if (this.chains.get(key) === previous.then(() => gate)) this.chains.delete(key);
		}
	}
}

export class RuntimeLedger {
	private readonly mutex = new KeyedMutex();

	constructor(private readonly filePath: string) {
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
		fs.chmodSync(dir, DIR_MODE);
		if (!fs.existsSync(filePath)) this.writeAtomic(emptyLedger());
		fs.chmodSync(filePath, FILE_MODE);
	}

	private read(): LedgerFile {
		try {
			const raw = fs.readFileSync(this.filePath, 'utf8');
			const parsed = JSON.parse(raw) as LedgerFile;
			if (parsed.schemaVersion !== 1 || typeof parsed.byRuntimeId !== 'object' || typeof parsed.generationToRuntimeId !== 'object') {
				throw new RuntimeUnavailable('The local runtime ledger is corrupt.');
			}
			return this.backfillReplicaIds(parsed);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyLedger();
			throw new RuntimeUnavailable('The local runtime ledger is unavailable.');
		}
	}

	/**
	 * `replicaId` was added to this record shape after some ledgers were
	 * already written to disk, and every caller treats it as a required
	 * string (`ensureReadyLocked`'s `broker.prepare(record.replicaId)`,
	 * REMOVE's `broker.cleanup(record.replicaId)`) — without this, a
	 * pre-upgrade record has no value for it at all (not even `null`), and
	 * `path.join(root, undefined)` throws on the very next ENSURE_READY,
	 * ACTIVATE, or REMOVE this process handles for it. Minted once, durably,
	 * the first time a pre-upgrade record is read back — every later read
	 * (including a concurrent one; this whole method runs synchronously, with
	 * no `await` inside it, so two reads never interleave) sees the same
	 * persisted value, never a re-mint.
	 */
	private backfillReplicaIds(state: LedgerFile): LedgerFile {
		let dirty = false;
		for (const record of Object.values(state.byRuntimeId)) {
			if (typeof record.replicaId !== 'string' || record.replicaId.length === 0) {
				record.replicaId = crypto.randomUUID();
				dirty = true;
			}
		}
		if (dirty) this.writeAtomic(state);
		return state;
	}

	/** Write-temp-then-rename keeps a crash mid-write from ever leaving a half-written ledger file on disk. */
	private writeAtomic(state: LedgerFile): void {
		const tmpPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify(state), { mode: FILE_MODE });
		fs.chmodSync(tmpPath, FILE_MODE);
		fs.renameSync(tmpPath, this.filePath);
	}

	get(generationId: string): RuntimeRecord | null {
		const state = this.read();
		const runtimeId = state.generationToRuntimeId[generationId];
		return runtimeId ? (state.byRuntimeId[runtimeId] ?? null) : null;
	}

	getByRuntimeId(runtimeId: string): RuntimeRecord | null {
		return this.read().byRuntimeId[runtimeId] ?? null;
	}

	/** Every mutating/reconciling operation on a runtime serializes through this — see class doc. */
	async withRuntimeLock<T>(runtimeId: string, fn: () => Promise<T> | T): Promise<T> {
		return this.mutex.withLock(`runtime:${runtimeId}`, fn);
	}

	claim(input: {
		generationId: string;
		installationId: string;
		generationNumber: number;
		requestHash: string;
		requestJson: string;
		runtimeId: string;
		artifactDigest: string;
		imageManifestDigest: string;
		imageConfigDigest: string;
		containerSpecHash: string;
		now: number;
	}): RuntimeRecord {
		const state = this.read();
		const existingRuntimeId = state.generationToRuntimeId[input.generationId];
		if (existingRuntimeId) {
			const record = state.byRuntimeId[existingRuntimeId]!;
			if (
				record.requestHash !== input.requestHash ||
				record.requestJson !== input.requestJson ||
				record.runtimeId !== input.runtimeId ||
				record.artifactDigest !== input.artifactDigest ||
				record.imageManifestDigest !== input.imageManifestDigest ||
				record.imageConfigDigest !== input.imageConfigDigest ||
				record.containerSpecHash !== input.containerSpecHash
			) {
				throw new AffinityConflict();
			}
			return record;
		}
		if (state.byRuntimeId[input.runtimeId]) {
			// A different generation_id already claimed this exact runtime_id
			// (the deterministic affinity hash collided with different affinity
			// fields feeding it) — refuse rather than overwrite.
			throw new AffinityConflict();
		}
		const record: RuntimeRecord = {
			generationId: input.generationId,
			installationId: input.installationId,
			generationNumber: input.generationNumber,
			requestHash: input.requestHash,
			requestJson: input.requestJson,
			runtimeId: input.runtimeId,
			artifactDigest: input.artifactDigest,
			imageManifestDigest: input.imageManifestDigest,
			imageConfigDigest: input.imageConfigDigest,
			containerSpecHash: input.containerSpecHash,
			containerId: null,
			state: 'CLAIMED',
			readyResponseJson: null,
			driverEvidenceJson: null,
			activationRequestHash: null,
			activationRequestJson: null,
			activeContainerSpecHash: null,
			activationClaimedAt: null,
			activeContainerReadyAt: null,
			activeResponseJson: null,
			activationEvidenceJson: null,
			createdAt: input.now,
			updatedAt: input.now,
			replicaId: crypto.randomUUID(),
			activeReplicaId: null,
			brokerRegisteredAt: null,
		};
		state.byRuntimeId[input.runtimeId] = record;
		state.generationToRuntimeId[input.generationId] = input.runtimeId;
		this.writeAtomic(state);
		return record;
	}

	recordContainer(generationId: string, requestHash: string, containerId: string, now: number): RuntimeRecord {
		const state = this.read();
		const runtimeId = state.generationToRuntimeId[generationId];
		const record = runtimeId ? state.byRuntimeId[runtimeId] : undefined;
		if (!record || record.requestHash !== requestHash) throw new AffinityConflict();
		record.containerId = containerId;
		record.updatedAt = now;
		this.writeAtomic(state);
		return record;
	}

	markReady(generationId: string, requestHash: string, readyResponseJson: string, driverEvidenceJson: string, now: number): RuntimeRecord {
		JSON.parse(readyResponseJson);
		JSON.parse(driverEvidenceJson);
		const state = this.read();
		const runtimeId = state.generationToRuntimeId[generationId];
		const record = runtimeId ? state.byRuntimeId[runtimeId] : undefined;
		if (!record || record.requestHash !== requestHash) throw new AffinityConflict();
		if (record.state === 'READY' || record.state === 'ACTIVATING' || record.state === 'ACTIVE') {
			if (record.readyResponseJson !== readyResponseJson || record.driverEvidenceJson !== driverEvidenceJson) {
				throw new AffinityConflict('Persisted READY evidence does not match this reconciliation.');
			}
			return record;
		}
		if (record.state !== 'CLAIMED' || record.containerId === null) {
			throw new RuntimeUnavailable('No supervised container identity was persisted.');
		}
		record.state = 'READY';
		record.readyResponseJson = readyResponseJson;
		record.driverEvidenceJson = driverEvidenceJson;
		record.updatedAt = now;
		this.writeAtomic(state);
		return record;
	}

	claimActivation(input: {
		runtimeId: string;
		requestHash: string;
		activationRequestHash: string;
		activationRequestJson: string;
		activeContainerSpecHash: string;
		now: number;
	}): RuntimeRecord {
		JSON.parse(input.activationRequestJson);
		const state = this.read();
		const record = state.byRuntimeId[input.runtimeId];
		if (!record || record.requestHash !== input.requestHash) {
			throw new AffinityConflict('The activation does not match the claimed runtime.');
		}
		if (record.state === 'CLAIMED') throw new RuntimeUnavailable('READY evidence must be durable before activation.');
		if (record.state === 'ACTIVATING' || record.state === 'ACTIVE') {
			if (
				record.activationRequestHash !== input.activationRequestHash ||
				record.activationRequestJson !== input.activationRequestJson ||
				record.activeContainerSpecHash !== input.activeContainerSpecHash ||
				typeof record.activationClaimedAt !== 'number' ||
				record.activationClaimedAt <= 0
			) {
				throw new AffinityConflict('The runtime was activated with different authorization affinity.');
			}
			return record;
		}
		if (record.state !== 'READY' || record.readyResponseJson === null) {
			throw new RuntimeUnavailable('READY evidence must be durable before activation.');
		}
		record.state = 'ACTIVATING';
		record.activationRequestHash = input.activationRequestHash;
		record.activationRequestJson = input.activationRequestJson;
		record.activeContainerSpecHash = input.activeContainerSpecHash;
		record.activationClaimedAt = input.now;
		record.activeReplicaId = crypto.randomUUID();
		record.updatedAt = input.now;
		this.writeAtomic(state);
		return record;
	}

	/** Records that the broker binding for `runtimeId`'s current phase was (re)registered — observability only. */
	recordBrokerRegistered(runtimeId: string, now: number): RuntimeRecord {
		const state = this.read();
		const record = state.byRuntimeId[runtimeId];
		if (!record) throw new RuntimeUnavailable('no local runtime record to record broker registration against');
		record.brokerRegisteredAt = now;
		record.updatedAt = now;
		this.writeAtomic(state);
		return record;
	}

	/** Every ACTIVE runtime's record — the startup rebind sweep's input (the broker's in-memory socket does not survive a process restart). */
	listActiveRecords(): RuntimeRecord[] {
		return Object.values(this.read().byRuntimeId).filter((record) => record.state === 'ACTIVE');
	}

	/** Every replica id this ledger still remembers, provisioning or finalized — used to identify orphan broker directories with no matching record. */
	listKnownReplicaIds(): string[] {
		const ids: string[] = [];
		for (const record of Object.values(this.read().byRuntimeId)) {
			ids.push(record.replicaId);
			if (record.activeReplicaId) ids.push(record.activeReplicaId);
		}
		return ids;
	}

	recordActiveContainerReady(input: { runtimeId: string; activationRequestHash: string; now: number }): RuntimeRecord {
		const state = this.read();
		const record = state.byRuntimeId[input.runtimeId];
		if (
			!record ||
			record.activationRequestHash !== input.activationRequestHash ||
			(record.state !== 'ACTIVATING' && record.state !== 'ACTIVE') ||
			record.containerId === null ||
			record.activeContainerSpecHash === null
		) {
			throw new AffinityConflict('The signed-only readiness does not match the activation intent.');
		}
		if (record.activeContainerReadyAt === null) {
			record.activeContainerReadyAt = input.now;
			record.updatedAt = input.now;
			this.writeAtomic(state);
		}
		return record;
	}

	markActive(input: {
		runtimeId: string;
		activationRequestHash: string;
		activeResponseJson: string;
		activationEvidenceJson: string;
		now: number;
	}): RuntimeRecord {
		JSON.parse(input.activeResponseJson);
		JSON.parse(input.activationEvidenceJson);
		const state = this.read();
		const record = state.byRuntimeId[input.runtimeId];
		if (!record || record.activationRequestHash !== input.activationRequestHash) {
			throw new AffinityConflict('The ACTIVE evidence does not match the activation intent.');
		}
		if (record.state === 'ACTIVE') {
			if (
				typeof record.activeContainerReadyAt !== 'number' ||
				record.activeContainerReadyAt <= 0 ||
				record.activeResponseJson !== input.activeResponseJson ||
				record.activationEvidenceJson !== input.activationEvidenceJson
			) {
				throw new AffinityConflict('Persisted ACTIVE evidence does not match this reconciliation.');
			}
			return record;
		}
		if (
			record.state !== 'ACTIVATING' ||
			record.containerId === null ||
			record.activeContainerSpecHash === null ||
			record.activationClaimedAt === null ||
			record.activeContainerReadyAt === null
		) {
			throw new RuntimeUnavailable('No signed-only supervised container identity was persisted.');
		}
		record.state = 'ACTIVE';
		record.activeResponseJson = input.activeResponseJson;
		record.activationEvidenceJson = input.activationEvidenceJson;
		record.updatedAt = input.now;
		this.writeAtomic(state);
		return record;
	}

	/** Drops the row so ABSENT stays a pure function of the verified request — the same row-deletion contract as `ledger.py`'s `delete_by_runtime_id`. */
	deleteByRuntimeId(runtimeId: string): boolean {
		const state = this.read();
		const record = state.byRuntimeId[runtimeId];
		if (!record) return false;
		delete state.byRuntimeId[runtimeId];
		delete state.generationToRuntimeId[record.generationId];
		this.writeAtomic(state);
		return true;
	}

	/** Every runtimeId currently recorded — used by boot/label-based orphan reconciliation. */
	listRuntimeIds(): string[] {
		return Object.keys(this.read().byRuntimeId);
	}
}
