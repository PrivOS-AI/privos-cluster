/**
 * Local-runtime identity broker integration — real `McpBrokerManager` over a
 * real unix socket, real `RuntimeService`, fake Docker only. Covers the
 * behaviour `broker-binding.test.ts` (pure functions) and
 * `runtime-service.test.ts` (Docker-fake affinity/network checks) don't:
 * the actual attest round trip, crash-replay/restart identity stability, and
 * REMOVE/rebind broker-directory hygiene.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { canonicalHash } from './abi-schema.js';
import { buildOciArchiveFixture } from './oci-archive-fixture.js';
import { ArtifactStore, type ArtifactStoreDocker } from './artifact-store.js';
import { RuntimeLedger } from './ledger.js';
import { RuntimeService, type ReadinessProbe, type RuntimeServiceConfig, type RuntimeServiceLogger } from './runtime-service.js';
import { McpBrokerManager } from '../services/mcp-broker.js';
import { CLUSTER_ID_FILENAME, writeStateFile } from '../state-dir.js';
import type { NodeIdentity } from '../security/node-identity.js';

const instantReadiness: ReadinessProbe = { waitReady: async () => {} };

const tmpDirs: string[] = [];
function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runtime-broker-test-'));
	tmpDirs.push(dir);
	return dir;
}
// See `runtime-service.test.ts` — the broker socket's `sun_path` has a
// 104-byte ceiling on macOS, so its root needs a short path under `/tmp`.
function tmpBrokerRoot(): string {
	const dir = fs.mkdtempSync(path.join('/tmp', 'privos-local-runtime-broker-'));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface FakeContainer {
	Id: string;
	Image: string;
	Config: { Image: string; Labels: Record<string, string>; User?: string };
	HostConfig: any;
	NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
	Mounts: any[];
	State: { Running: boolean };
}

/** A trimmed Docker double — only the calls `RuntimeService` actually makes. `restartCalls` is what the rebind tests check. */
class FakeDockerode {
	networks = new Map<string, { Internal: boolean; Containers: Record<string, unknown> }>();
	containers = new Map<string, FakeContainer>();
	restartCalls: string[] = [];

	async createNetwork(opts: { Name: string; Internal?: boolean }): Promise<void> {
		if (this.networks.has(opts.Name)) { const err: any = new Error('conflict'); err.statusCode = 409; throw err; }
		this.networks.set(opts.Name, { Internal: Boolean(opts.Internal), Containers: {} });
	}

	async createContainer(spec: any): Promise<{ id: string; start: () => Promise<void> }> {
		const id = `cid-${spec.name}-${crypto.randomUUID()}`;
		const mounts = (spec.HostConfig?.Mounts ?? []).map((m: any) => ({ Source: m.Source, Destination: m.Target, RW: !m.ReadOnly }));
		const record: FakeContainer = {
			Id: id,
			Image: spec.Image,
			Config: { Image: spec.Image, Labels: spec.Labels, User: spec.User },
			HostConfig: spec.HostConfig,
			NetworkSettings: { Networks: { [spec.HostConfig.NetworkMode]: { IPAddress: '10.99.0.5' } } },
			Mounts: mounts,
			State: { Running: false },
		};
		this.containers.set(spec.name, record);
		return { id, start: async () => { record.State.Running = true; } };
	}

	async listContainers(opts: { filters?: { label?: string[] } } = {}): Promise<Array<{ Id: string; Labels: Record<string, string> }>> {
		const keys = opts.filters?.label ?? [];
		return [...this.containers.values()]
			.filter((c) => keys.every((key) => c.Config.Labels?.[key] !== undefined))
			.map((c) => ({ Id: c.Id, Labels: c.Config.Labels }));
	}

	getNetwork(name: string) {
		return {
			inspect: async () => {
				const net = this.networks.get(name);
				if (!net) { const err: any = new Error('not found'); err.statusCode = 404; throw err; }
				return { Internal: net.Internal, Containers: net.Containers };
			},
			connect: async (opts: { Container: string }) => {
				this.networks.get(name)!.Containers[opts.Container] = {};
				const found = this.findByIdOrName(opts.Container);
				if (found) found[1].NetworkSettings.Networks[name] = { IPAddress: '10.99.0.9' };
			},
			disconnect: async (opts: { Container: string }) => { delete this.networks.get(name)?.Containers[opts.Container]; },
			remove: async () => { this.networks.delete(name); },
		};
	}

	private findByIdOrName(idOrName: string): [string, FakeContainer] | undefined {
		const byName = this.containers.get(idOrName);
		if (byName) return [idOrName, byName];
		for (const [name, record] of this.containers) if (record.Id === idOrName) return [name, record];
		return undefined;
	}

	getContainer(idOrName: string) {
		return {
			inspect: async () => {
				const found = this.findByIdOrName(idOrName);
				if (!found) { const err: any = new Error('not found'); err.statusCode = 404; throw err; }
				return found[1];
			},
			start: async () => { const found = this.findByIdOrName(idOrName); if (found) found[1].State.Running = true; },
			stop: async () => { const found = this.findByIdOrName(idOrName); if (found) found[1].State.Running = false; },
			restart: async () => {
				const found = this.findByIdOrName(idOrName);
				if (!found) { const err: any = new Error('not found'); err.statusCode = 404; throw err; }
				this.restartCalls.push(found[1].Id);
			},
			remove: async () => {
				const found = this.findByIdOrName(idOrName);
				if (!found) { const err: any = new Error('not found'); err.statusCode = 404; throw err; }
				this.containers.delete(found[0]);
			},
		};
	}
}

class FakeArtifactStoreDocker implements ArtifactStoreDocker {
	images = new Map<string, { Id: string }>();
	async loadArchive(): Promise<void> {}
	async inspectImage(reference: string) { return this.images.get(reference) ?? null; }
	prime(configDigest: string): void { this.images.set(configDigest, { Id: configDigest }); }
	async removeImage(reference: string): Promise<void> { this.images.delete(reference); }
}

function baseEnsureReadyRequest(artifactDigest: string) {
	return {
		protocol_version: 3,
		operation: 'ENSURE_READY',
		installation_id: 'installation-local-1',
		workspace_id: 'workspace-1',
		deployment_id: 'deployment-1',
		listing_id: 'listing-1',
		version_id: 'version-1',
		generation_id: 'generation-1',
		generation_number: 1,
		descriptor_artifact_hash: 'A'.repeat(43),
		resource_manifest_hash: 'B'.repeat(43),
		permission_contract_hash: 'C'.repeat(43),
		runtime_authorization: {
			security_mode: 'runtime-v3',
			hub_kid: 'Cw2abzT4NR_Pi3PZCD7Y-NnTH3UKcA-Xdu3wHLwTZVI',
			hub_public_jwk: {
				kty: 'EC',
				crv: 'P-256',
				x: 'QnQhvyhIzIERjpS3t5rHEiNULLmV_ABrViKZRO32IQE',
				y: 'c4BDW1f1M7vJfiqYgLe537irq5Y6OvZ-ay9d-mYMYLw',
			},
			mcp_app_id: 'mcp-app-1',
			manifest_digest: `sha256:${'a'.repeat(64)}`,
			allow_unsigned_preactivation_readiness: true,
		},
		artifact: { path: '/var/lib/privos/marketplace/apps/local-1.privos-app', digest: artifactDigest, size_bytes: 4096 },
		runtime_spec: {
			driver_abi: 'privos-local-runtime-driver-v1',
			artifact_format: 'oci-image-archive-v1',
			port: 3001,
			resources: { memory_mb: 512, cpus: 0.5, tmp_size_mb: 64 },
		},
	};
}

function activationFor(ready: any, request: unknown) {
	return {
		protocol_version: 3,
		operation: 'ACTIVATE',
		installation_id: ready.installation_id,
		workspace_id: ready.workspace_id,
		deployment_id: ready.deployment_id,
		listing_id: ready.listing_id,
		version_id: ready.version_id,
		generation_id: ready.generation_id,
		generation_number: ready.generation_number,
		descriptor_artifact_hash: ready.descriptor_artifact_hash,
		resource_manifest_hash: ready.resource_manifest_hash,
		permission_contract_hash: ready.permission_contract_hash,
		runtime_authorization: ready.runtime_authorization,
		runtime_id: ready.runtime_id,
		artifact_digest: ready.artifact_digest,
		ensure_ready_request_hash: canonicalHash(request),
		runtime_resource_inventory_hash: 'D'.repeat(43),
		runtime_approval_receipt_hash: 'E'.repeat(43),
		runtime_authorization_epoch: 1,
	};
}

/** Fake `NodeIdentity` that never signs for real — captures the exact payload `respond()` built, matching `mcp-broker.test.ts`'s own pattern. */
function capturingIdentity(sink: { payload?: Record<string, unknown> }): NodeIdentity {
	return {
		sign: async (payload: Record<string, unknown>) => {
			sink.payload = payload;
			return 'signed-attestation';
		},
	} as unknown as NodeIdentity;
}

async function requestBroker(socketPath: string, request: unknown): Promise<any> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let response = '';
		socket.setEncoding('utf8');
		socket.once('error', reject);
		socket.on('data', (chunk) => { response += chunk; });
		socket.on('end', () => { try { resolve(JSON.parse(response)); } catch (err) { reject(err); } });
		socket.on('connect', () => socket.end(`${JSON.stringify(request)}\n`));
	});
}

function dpopRequest(): { op: 'attest'; publicJwk: crypto.JsonWebKey; nonce: string } {
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	return { op: 'attest', publicJwk: pair.publicKey.export({ format: 'jwk' }), nonce: 'workload-nonce-123456' };
}

async function setup(options: { brokerRoot?: string; ledgerPath?: string; signedPayload?: { payload?: Record<string, unknown> }; logger?: RuntimeServiceLogger } = {}) {
	const stateDir = tmpDir();
	writeStateFile(stateDir, CLUSTER_ID_FILENAME, 'hub-assigned-cluster-id');
	const ledger = new RuntimeLedger(options.ledgerPath ?? path.join(stateDir, 'runtimes.json'));
	const fakeArtifactDocker = new FakeArtifactStoreDocker();
	const artifactStore = new ArtifactStore(path.join(stateDir, 'artifacts'), fakeArtifactDocker, 250_000_000, 3);
	const fixture = buildOciArchiveFixture(['SEED=1']);
	fakeArtifactDocker.prime(fixture.configDigest);
	const artifactTarPath = path.join(stateDir, 'incoming.tar');
	fs.writeFileSync(artifactTarPath, fixture.tar);
	const staged = await artifactStore.stage({ path: artifactTarPath, sha256: fixture.digest, sizeBytes: fixture.tar.length });

	const dockerode = new FakeDockerode();
	const brokerRoot = options.brokerRoot ?? tmpBrokerRoot();
	const identity = capturingIdentity(options.signedPayload ?? {});
	const broker = new McpBrokerManager(brokerRoot, identity, (id: string) => dockerode.getContainer(id).inspect());
	const config: RuntimeServiceConfig = {
		privateNetwork: 'privos-local-runtime',
		pidsLimit: 128,
		readyTimeoutSeconds: 5,
		stateDir,
		fallbackClusterId: 'privos-app-cluster',
		nodeId: 'local-node',
		hubOrigin: 'https://hub.example.com',
		brokerRoot,
	};
	const service = new RuntimeService(dockerode as any, ledger, artifactStore, broker, config, () => 1_700_000_000_000, instantReadiness, options.logger);
	return { service, dockerode, ledger, artifactStore, staged, broker, brokerRoot, config, stateDir };
}

test('a finalized attest succeeds through the real socket; iss carries the paired cluster id and the payload matches the ACTIVATE affinity', async () => {
	const signed: { payload?: Record<string, unknown> } = {};
	const { service, ledger, staged, brokerRoot } = await setup({ signedPayload: signed });
	const request = baseEnsureReadyRequest(staged.digest);
	const ready = await service.ensureReady(request);
	const activation = activationFor(ready, request);
	await service.activate(activation);

	const record = ledger.getByRuntimeId(ready.runtime_id)!;
	const socketPath = path.join(brokerRoot, record.activeReplicaId!, 'identity.sock');
	const response = await requestBroker(socketPath, dpopRequest());

	assert.equal(response.ok, true);
	assert.equal(response.attestation, 'signed-attestation');
	assert.equal(signed.payload?.iss, 'urn:privos:cluster-node:hub-assigned-cluster-id:local-node');
	assert.equal(signed.payload?.replicaId, record.activeReplicaId);
	assert.equal(signed.payload?.runtimeResourceInventoryHash, activation.runtime_resource_inventory_hash);
	assert.equal(signed.payload?.approvalReceiptHash, activation.runtime_approval_receipt_hash);
	assert.equal(signed.payload?.authorizationEpoch, activation.runtime_authorization_epoch);
	// The Hub stores `ready.artifact_digest` as the installation's expected
	// image digest and compares a SELF_HOSTED_LOCAL attestation's `imageDigest`
	// against exactly that value — never the OCI image config digest.
	assert.equal(signed.payload?.imageDigest, ready.artifact_digest);
});

test('a provisioning (PREACTIVATION) attest is refused until inventory is established', async () => {
	const { service, ledger, staged, brokerRoot } = await setup();
	const request = baseEnsureReadyRequest(staged.digest);
	const ready = await service.ensureReady(request);

	const record = ledger.getByRuntimeId(ready.runtime_id)!;
	const socketPath = path.join(brokerRoot, record.replicaId, 'identity.sock');
	const response = await requestBroker(socketPath, dpopRequest());

	assert.deepEqual(response, { ok: false, error: 'runtime_inventory_not_established' });
});

test('ACTIVATE replay after a simulated crash-retry keeps exactly one final replicaId, broker directory, and socket', async () => {
	const { service, ledger, staged, brokerRoot } = await setup();
	const request = baseEnsureReadyRequest(staged.digest);
	const ready = await service.ensureReady(request);
	const activation = activationFor(ready, request);

	const first = await service.activate(activation);
	const recordAfterFirst = ledger.getByRuntimeId(ready.runtime_id)!;
	const replicaId = recordAfterFirst.activeReplicaId!;

	// A crash-retry resubmits the identical ACTIVATE request; `claimActivation`
	// must replay the same activeReplicaId, never mint a second one.
	const second = await service.activate(activation);
	assert.deepEqual(first, second);
	assert.equal(ledger.getByRuntimeId(ready.runtime_id)!.activeReplicaId, replicaId);

	const brokerDirs = await fsPromises.readdir(brokerRoot);
	assert.deepEqual(brokerDirs, [replicaId]);
	assert.equal(fs.existsSync(path.join(brokerRoot, replicaId, 'identity.sock')), true);
});

test('REMOVE leaves no broker directory behind', async () => {
	const { service, staged, brokerRoot } = await setup();
	const request = baseEnsureReadyRequest(staged.digest);
	const ready = await service.ensureReady(request);
	const activation = activationFor(ready, request);
	await service.activate(activation);

	await service.remove({
		protocol_version: 3,
		operation: 'REMOVE',
		installation_id: ready.installation_id,
		workspace_id: ready.workspace_id,
		deployment_id: ready.deployment_id,
		listing_id: ready.listing_id,
		version_id: ready.version_id,
		generation_id: ready.generation_id,
		generation_number: ready.generation_number,
		descriptor_artifact_hash: ready.descriptor_artifact_hash,
		resource_manifest_hash: ready.resource_manifest_hash,
		permission_contract_hash: ready.permission_contract_hash,
		runtime_authorization: ready.runtime_authorization,
		runtime_id: ready.runtime_id,
		artifact_digest: ready.artifact_digest,
	});

	assert.deepEqual(await fsPromises.readdir(brokerRoot), []);
});

test('rebindActiveRuntimes recreates the broker socket after a simulated process restart and restarts the app container', async () => {
	const brokerRoot = tmpBrokerRoot();
	const ledgerPath = path.join(tmpDir(), 'runtimes.json');
	const setupA = await setup({ brokerRoot, ledgerPath });
	const request = baseEnsureReadyRequest(setupA.staged.digest);
	const ready = await setupA.service.ensureReady(request);
	const activation = activationFor(ready, request);
	await setupA.service.activate(activation);
	const record = setupA.ledger.getByRuntimeId(ready.runtime_id)!;
	const socketPath = path.join(brokerRoot, record.activeReplicaId!, 'identity.sock');

	// Simulate the process restarting: same ledger file, same Docker state
	// (the fake stands in for the real daemon, which survives a process
	// restart), same broker root directory on disk — but a BRAND NEW
	// `McpBrokerManager` instance, whose in-memory socket server does not.
	await setupA.broker.closeAll();
	fs.rmSync(socketPath, { force: true });
	assert.equal(fs.existsSync(socketPath), false);

	const identityB: { payload?: Record<string, unknown> } = {};
	const brokerB = new McpBrokerManager(brokerRoot, capturingIdentity(identityB), (id: string) => setupA.dockerode.getContainer(id).inspect());
	const ledgerB = new RuntimeLedger(ledgerPath);
	const serviceB = new RuntimeService(setupA.dockerode as any, ledgerB, setupA.artifactStore, brokerB, setupA.config, () => 1_700_000_000_000, instantReadiness);

	const result = await serviceB.rebindActiveRuntimes();

	assert.equal(result.rebound, 1);
	assert.equal(result.failed, 0);
	assert.equal(fs.existsSync(socketPath), true);
	assert.deepEqual(setupA.dockerode.restartCalls, [record.containerId]);
});

test('rebindActiveRuntimes recovers from a conflicting on-disk binding by cleaning up and re-registering', async () => {
	const brokerRoot = tmpBrokerRoot();
	const ledgerPath = path.join(tmpDir(), 'runtimes.json');
	const setupA = await setup({ brokerRoot, ledgerPath });
	const request = baseEnsureReadyRequest(setupA.staged.digest);
	const ready = await setupA.service.ensureReady(request);
	const activation = activationFor(ready, request);
	await setupA.service.activate(activation);
	const record = setupA.ledger.getByRuntimeId(ready.runtime_id)!;
	const bindingPath = path.join(brokerRoot, record.activeReplicaId!, 'binding-v3.json');

	await setupA.broker.closeAll();
	// Corrupt the persisted binding so the freshly rebuilt one conflicts with it.
	await fsPromises.writeFile(bindingPath, `${JSON.stringify({ tampered: true })}\n`);

	const brokerB = new McpBrokerManager(brokerRoot, capturingIdentity({}), (id: string) => setupA.dockerode.getContainer(id).inspect());
	const ledgerB = new RuntimeLedger(ledgerPath);
	const serviceB = new RuntimeService(setupA.dockerode as any, ledgerB, setupA.artifactStore, brokerB, setupA.config, () => 1_700_000_000_000, instantReadiness);

	const result = await serviceB.rebindActiveRuntimes();

	assert.equal(result.rebound, 1);
	assert.equal(result.failed, 0);
	const rewritten = JSON.parse(await fsPromises.readFile(bindingPath, 'utf8'));
	assert.equal(rewritten.tampered, undefined);
	assert.equal(rewritten.replicaId, record.activeReplicaId);
});

test('the startup sweep removes a broker directory with no matching ledger record', async () => {
	const { service, staged, brokerRoot, broker } = await setup();
	const request = baseEnsureReadyRequest(staged.digest);
	await service.ensureReady(request);

	const orphanReplicaId = crypto.randomUUID();
	await broker.prepare(orphanReplicaId);
	assert.equal(fs.existsSync(path.join(brokerRoot, orphanReplicaId)), true);

	await service.rebindActiveRuntimes();

	assert.equal(fs.existsSync(path.join(brokerRoot, orphanReplicaId)), false);
});

test('the startup sweep keeps a MANAGED replica directory that a live container still names', async () => {
	const { service, dockerode, brokerRoot, broker } = await setup();
	const managedReplicaId = crypto.randomUUID();
	await broker.prepare(managedReplicaId);
	await dockerode.createContainer({
		name: 'managed-app',
		Image: 'managed@sha256:0',
		Labels: { 'mcp-app': 'true', 'privos.mcp.replica': managedReplicaId },
		HostConfig: { NetworkMode: 'privos' },
	});

	await service.rebindActiveRuntimes();

	assert.equal(fs.existsSync(path.join(brokerRoot, managedReplicaId)), true);
});

// A host reboot or an operator recreating the network outside this process
// can leave `privos-local-runtime` back on the wrong `Internal` flag. Every
// ACTIVE app container this rebind restarts must come back up already on the
// reconciled network, not on whatever a later ensureReady/activate call
// happens to fix (which, for an already-ACTIVE generation, may never come).
test('rebindActiveRuntimes reconciles the runtime network to non-internal before restarting any container', async () => {
	const brokerRoot = tmpBrokerRoot();
	const ledgerPath = path.join(tmpDir(), 'runtimes.json');
	const setupA = await setup({ brokerRoot, ledgerPath });
	const request = baseEnsureReadyRequest(setupA.staged.digest);
	const ready = await setupA.service.ensureReady(request);
	const activation = activationFor(ready, request);
	await setupA.service.activate(activation);

	// Simulate the network having been recreated internal again by something
	// outside this process between runs (e.g. a host reboot recreating it from
	// a stale compose/systemd unit).
	await setupA.dockerode.getNetwork('privos-local-runtime').remove();
	await setupA.dockerode.createNetwork({ Name: 'privos-local-runtime', Internal: true });

	await setupA.broker.closeAll();
	const brokerB = new McpBrokerManager(brokerRoot, capturingIdentity({}), (id: string) => setupA.dockerode.getContainer(id).inspect());
	const ledgerB = new RuntimeLedger(ledgerPath);
	const serviceB = new RuntimeService(setupA.dockerode as any, ledgerB, setupA.artifactStore, brokerB, setupA.config, () => 1_700_000_000_000, instantReadiness);

	const result = await serviceB.rebindActiveRuntimes();

	assert.equal(result.failed, 0);
	assert.equal(setupA.dockerode.networks.get('privos-local-runtime')?.Internal, false);
});

test('rebindActiveRuntimes logs the runtimeId and error for a record it fails to rebind, not just a silent count', async () => {
	const ledgerPath = path.join(tmpDir(), 'runtimes.json');
	const warnings: Array<{ details: Record<string, unknown>; message: string }> = [];
	const logger: RuntimeServiceLogger = {
		warn: (...args: unknown[]) => { warnings.push({ details: args[0] as Record<string, unknown>, message: args[1] as string }); },
	};
	const setupA = await setup({ ledgerPath, logger });
	const request = baseEnsureReadyRequest(setupA.staged.digest);
	const ready = await setupA.service.ensureReady(request);
	const activation = activationFor(ready, request);
	await setupA.service.activate(activation);

	// Corrupt the persisted ACTIVE record so this specific runtime's rebind
	// throws instead of succeeding, without touching any other record.
	const raw = JSON.parse(await fsPromises.readFile(ledgerPath, 'utf8')) as { byRuntimeId: Record<string, { containerId?: string }> };
	delete raw.byRuntimeId[ready.runtime_id]!.containerId;
	await fsPromises.writeFile(ledgerPath, JSON.stringify(raw));

	const result = await setupA.service.rebindActiveRuntimes();

	assert.equal(result.rebound, 0);
	assert.equal(result.failed, 1);
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0]!.details.runtimeId, ready.runtime_id);
	assert.ok(warnings[0]!.details.err, 'the failure must carry the actual error, not just increment a counter');
});
