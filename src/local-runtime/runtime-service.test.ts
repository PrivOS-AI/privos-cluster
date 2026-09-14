import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { RuntimeService, type ReadinessProbe } from './runtime-service.js';
import { RuntimeLedger } from './ledger.js';
import { ArtifactStore, type ArtifactStoreDocker } from './artifact-store.js';
import { buildOciArchiveFixture } from './oci-archive-fixture.js';
import { canonicalHash } from './abi-schema.js';
import { ArtifactNotStaged, RuntimeNotFound } from './errors.js';
import { McpBrokerManager } from '../services/mcp-broker.js';
import type { NodeIdentity } from '../security/node-identity.js';

const tmpDirs: string[] = [];
function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-service-test-'));
	tmpDirs.push(dir);
	return dir;
}
// The broker's unix socket path (`brokerRoot/<replicaId>/identity.sock`) has a
// 104-byte `sun_path` ceiling on macOS — `os.tmpdir()` resolves under the deep
// `/var/folders/...` path there, so the broker root needs its own short tmp
// dir directly under `/tmp` (same fix `mcp-broker.test.ts` already uses).
function tmpBrokerRoot(): string {
	const dir = fs.mkdtempSync(path.join('/tmp', 'privos-local-runtime-broker-'));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const instantReadiness: ReadinessProbe = { waitReady: async () => {} };

interface FakeContainer {
	Id: string;
	Image: string;
	Config: { Image: string; Labels: Record<string, string>; User?: string };
	HostConfig: any;
	NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
	Mounts: any[];
	State: { Running: boolean };
}

interface FakeNetwork {
	Internal: boolean;
	Containers: Record<string, unknown>;
}

class FakeDockerode {
	networks = new Map<string, FakeNetwork>();
	containers = new Map<string, FakeContainer>(); // keyed by name
	createContainerCalls = 0;
	removeCalls = 0;

	async createNetwork(opts: { Name: string; Internal?: boolean }): Promise<void> {
		if (this.networks.has(opts.Name)) {
			const err: any = new Error('conflict');
			err.statusCode = 409;
			throw err;
		}
		this.networks.set(opts.Name, { Internal: Boolean(opts.Internal), Containers: {} });
	}

	async createContainer(spec: any): Promise<{ id: string; start: () => Promise<void> }> {
		this.createContainerCalls++;
		const id = `cid-${spec.name}-${this.createContainerCalls}`;
		const mounts = (spec.HostConfig?.Mounts ?? []).map((mount: any) => ({
			Source: mount.Source,
			Destination: mount.Target,
			RW: !mount.ReadOnly,
		}));
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

	networkConnects: { network: string; Container: string }[] = [];
	networkDisconnects: { network: string; Container: string }[] = [];
	networkRemoves: string[] = [];

	getNetwork(name: string) {
		return {
			inspect: async () => {
				const net = this.networks.get(name);
				if (!net) { const err: any = new Error('not found'); err.statusCode = 404; throw err; }
				return { Internal: net.Internal, Containers: net.Containers };
			},
			connect: async (opts: { Container: string }) => {
				this.networkConnects.push({ network: name, Container: opts.Container });
				this.networks.get(name)?.Containers && (this.networks.get(name)!.Containers[opts.Container] = {});
				const found = this.findByIdOrName(opts.Container);
				if (found) found[1].NetworkSettings.Networks[name] = { IPAddress: '10.99.0.9' };
			},
			disconnect: async (opts: { Container: string }) => {
				this.networkDisconnects.push({ network: name, Container: opts.Container });
				delete this.networks.get(name)?.Containers[opts.Container];
			},
			remove: async () => {
				this.networkRemoves.push(name);
				this.networks.delete(name);
			},
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
			start: async () => {
				const found = this.findByIdOrName(idOrName);
				if (found) found[1].State.Running = true;
			},
			stop: async () => {
				const found = this.findByIdOrName(idOrName);
				if (found) found[1].State.Running = false;
			},
			remove: async () => {
				const found = this.findByIdOrName(idOrName);
				if (!found) { const err: any = new Error('not found'); err.statusCode = 404; throw err; }
				this.removeCalls++;
				this.containers.delete(found[0]);
			},
		};
	}
}

class FakeArtifactStoreDocker implements ArtifactStoreDocker {
	images = new Map<string, { Id: string }>();
	async loadArchive(): Promise<void> {}
	async inspectImage(reference: string) {
		return this.images.get(reference) ?? null;
	}
	prime(configDigest: string): void {
		this.images.set(configDigest, { Id: configDigest });
	}

	async removeImage(reference: string): Promise<void> {
		this.images.delete(reference);
	}
}

function baseEnsureReadyRequest(overrides: Partial<Record<string, unknown>> = {}, artifactDigest: string) {
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
		...overrides,
	};
}

async function setup(options: { user?: string; selfContainerId?: string; selfIsContainer?: boolean } = {}) {
	const stateDir = tmpDir();
	const ledger = new RuntimeLedger(path.join(stateDir, 'runtimes.json'));
	const fakeArtifactDocker = new FakeArtifactStoreDocker();
	const artifactStore = new ArtifactStore(path.join(stateDir, 'artifacts'), fakeArtifactDocker, 250_000_000, 3);
	const fixture = buildOciArchiveFixture(['SEED=1'], options.user ? { user: options.user } : {});
	fakeArtifactDocker.prime(fixture.configDigest);
	const artifactTarPath = path.join(stateDir, 'incoming.tar');
	fs.writeFileSync(artifactTarPath, fixture.tar);
	const staged = await artifactStore.stage({ path: artifactTarPath, sha256: fixture.digest, sizeBytes: fixture.tar.length });

	const dockerode = new FakeDockerode();
	if (options.selfContainerId && options.selfIsContainer !== false) {
		// This process's own container, as Docker would report it.
		dockerode.containers.set(options.selfContainerId, {
			Id: options.selfContainerId,
			Image: 'privos-app-cluster',
			Config: { Image: 'privos-app-cluster', Labels: {} },
			HostConfig: {},
			NetworkSettings: { Networks: {} },
			Mounts: [],
			State: { Running: true },
		});
	}
	const brokerRoot = tmpBrokerRoot();
	const broker = new McpBrokerManager(
		brokerRoot,
		{} as NodeIdentity, // never signs in these tests — no test here drives a real attest request
		(id: string) => dockerode.getContainer(id).inspect(),
	);
	const service = new RuntimeService(
		dockerode as any,
		ledger,
		artifactStore,
		broker,
		{
			privateNetwork: 'privos-local-runtime',
			pidsLimit: 128,
			readyTimeoutSeconds: 5,
			stateDir,
			fallbackClusterId: 'privos-app-cluster',
			nodeId: 'local-node',
			hubOrigin: 'https://hub.example.com',
			brokerRoot,
			...(options.selfContainerId ? { selfContainerId: options.selfContainerId } : {}),
		},
		() => 1_700_000_000_000,
		instantReadiness,
	);
	return { service, dockerode, ledger, artifactStore, staged, fixture, broker, stateDir, brokerRoot };
}

test('ensureReady stages a valid runtime: READY evidence, no host port, read-only rootfs, exactly the broker mount, non-internal network', async () => {
	const { service, dockerode, staged, brokerRoot } = await setup();
	const request = baseEnsureReadyRequest({}, staged.digest);
	const ready = await service.ensureReady(request);

	assert.equal(ready.state, 'READY');
	assert.equal(ready.artifact_digest, staged.digest);
	assert.match(ready.endpoint, /^http:\/\/[0-9a-f]{32}\.app-cluster\.internal$/);
	assert.equal(ready.endpoint.endsWith('/'), false);

	const container = [...dockerode.containers.values()][0]!;
	assert.equal(container.Image, staged.imageRef);
	assert.equal(container.HostConfig.NetworkMode, 'privos-local-runtime');
	assert.equal(container.HostConfig.ReadonlyRootfs, true);
	assert.deepEqual(container.HostConfig.PortBindings, {});
	assert.deepEqual(container.HostConfig.Binds, []);
	assert.equal(container.Mounts.length, 1);
	assert.equal(container.Mounts[0].Destination, '/run/privos');
	assert.equal(container.Mounts[0].RW, false);
	assert.ok(container.Mounts[0].Source.startsWith(brokerRoot));
	assert.equal(container.State.Running, true);
	assert.equal(dockerode.networks.get('privos-local-runtime')?.Internal, false);
});

test('ensureReady is idempotent: a repeat call replays the exact stored READY document with no second container create', async () => {
	const { service, dockerode, staged } = await setup();
	const request = baseEnsureReadyRequest({}, staged.digest);
	const first = await service.ensureReady(request);
	const second = await service.ensureReady(request);
	assert.deepEqual(first, second);
	assert.equal(dockerode.createContainerCalls, 1);
});

test('status replays the stored READY document byte-identically', async () => {
	const { service, staged } = await setup();
	const request = baseEnsureReadyRequest({}, staged.digest);
	const ready = await service.ensureReady(request);
	const replayed = await service.status(ready.runtime_id);
	assert.deepEqual(ready, replayed);
});

test('status for an unknown runtimeId is RuntimeNotFound', async () => {
	const { service } = await setup();
	await assert.rejects(() => service.status('local-runtime-' + '0'.repeat(32)), RuntimeNotFound);
});

test('ensureReady with a digest that was never staged is refused before any Docker call', async () => {
	const { service, dockerode } = await setup();
	const request = baseEnsureReadyRequest({}, `sha256:${'9'.repeat(64)}`);
	await assert.rejects(() => service.ensureReady(request), ArtifactNotStaged);
	assert.equal(dockerode.createContainerCalls, 0);
});

test('activate transitions the runtime to ACTIVE with activation evidence and recreates the container with ACTIVE labels', async () => {
	const { service, dockerode, staged } = await setup();
	const request = baseEnsureReadyRequest({}, staged.digest);
	const ready = await service.ensureReady(request);

	const activation = {
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

	const active = await service.activate(activation);
	assert.equal(active.state, 'ACTIVE');
	assert.equal(active.unsigned_readiness_disabled, true);
	assert.ok(active.activation_evidence_hash);

	const container = [...dockerode.containers.values()][0]!;
	assert.equal(container.Config.Labels['privos.local-runtime.authorization-phase'], 'ACTIVE');
	// A repeat activate() call replays instead of recreating.
	const replay = await service.activate(activation);
	assert.deepEqual(active, replay);
});

test('an in-place revision readies a second runtime for the same generation; activation moves the generation slot; removing the previous one leaves the new one live', async () => {
	const { service, dockerode, ledger, staged } = await setup();
	const activationFor = (ready: any, request: any) => ({
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
	});
	const previous = baseEnsureReadyRequest({}, staged.digest);
	const readyPrevious = await service.ensureReady(previous);
	await service.activate(activationFor(readyPrevious, previous));

	// Same generation, next revision: a second runtime must come up next to the live one.
	const next = baseEnsureReadyRequest({ generation_number: 2 }, staged.digest);
	const readyNext = await service.ensureReady(next);
	assert.notEqual(readyNext.runtime_id, readyPrevious.runtime_id);
	assert.equal(ledger.get(readyPrevious.generation_id)!.runtimeId, readyPrevious.runtime_id);
	assert.equal(ledger.getByRuntimeId(readyPrevious.runtime_id)!.state, 'ACTIVE');
	assert.equal(dockerode.containers.size, 2);

	await service.activate(activationFor(readyNext, next));
	assert.equal(ledger.get(readyPrevious.generation_id)!.runtimeId, readyNext.runtime_id);

	await service.remove({
		protocol_version: 3,
		operation: 'REMOVE',
		installation_id: readyPrevious.installation_id,
		workspace_id: readyPrevious.workspace_id,
		deployment_id: readyPrevious.deployment_id,
		listing_id: readyPrevious.listing_id,
		version_id: readyPrevious.version_id,
		generation_id: readyPrevious.generation_id,
		generation_number: readyPrevious.generation_number,
		descriptor_artifact_hash: readyPrevious.descriptor_artifact_hash,
		resource_manifest_hash: readyPrevious.resource_manifest_hash,
		permission_contract_hash: readyPrevious.permission_contract_hash,
		runtime_authorization: readyPrevious.runtime_authorization,
		runtime_id: readyPrevious.runtime_id,
		artifact_digest: readyPrevious.artifact_digest,
	});
	assert.equal(ledger.getByRuntimeId(readyPrevious.runtime_id), null);
	assert.equal(ledger.get(readyPrevious.generation_id)!.runtimeId, readyNext.runtime_id);
	assert.equal(ledger.getByRuntimeId(readyNext.runtime_id)!.state, 'ACTIVE');
	assert.equal(dockerode.containers.size, 1);
});

test('remove deletes the container and the ledger row and returns ABSENT with removal evidence; a repeat remove is idempotent', async () => {
	const { service, dockerode, ledger, staged } = await setup();
	const request = baseEnsureReadyRequest({}, staged.digest);
	const ready = await service.ensureReady(request);

	const removeRequest = {
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
	};

	const absent = await service.remove(removeRequest);
	assert.equal(absent.state, 'ABSENT');
	assert.ok(absent.removal_evidence_hash);
	assert.equal(dockerode.containers.size, 0);
	assert.equal(ledger.getByRuntimeId(ready.runtime_id), null);

	const secondAbsent = await service.remove(removeRequest);
	assert.equal(secondAbsent.state, 'ABSENT');
});


// The image decides who it runs as. Overriding that with a fixed uid broke the
// very first real artifact (EACCES on its own package.json), because its files
// belong to the user it was built for. Root is the one identity never honoured.
test('the runtime container runs as the user the image declares', async () => {
	const { service, dockerode, staged } = await setup({ user: 'node' });
	await service.ensureReady(baseEnsureReadyRequest({}, staged.digest));
	assert.equal([...dockerode.containers.values()][0]!.Config.User, 'node');
});

test('an image that declares no user runs as the unprivileged fallback', async () => {
	const { service, dockerode, staged } = await setup();
	await service.ensureReady(baseEnsureReadyRequest({}, staged.digest));
	assert.equal([...dockerode.containers.values()][0]!.Config.User, '65532:65532');
});

test('an image that asks for root gets the unprivileged fallback instead', async () => {
	const { service, dockerode, staged } = await setup({ user: 'root' });
	await service.ensureReady(baseEnsureReadyRequest({}, staged.digest));
	assert.equal([...dockerode.containers.values()][0]!.Config.User, '65532:65532');
});

// Readiness and forwarding dial the app on the private network, which Docker
// only routes between members. Running as a container, the driver must join it
// or it can never reach anything it starts.
test('when the driver runs as a container it joins the private network before probing', async () => {
	const { service, dockerode, staged } = await setup({ selfContainerId: 'app-cluster-self' });
	await service.ensureReady(baseEnsureReadyRequest({}, staged.digest));
	assert.ok(
		dockerode.networkConnects.some((c) => c.network === 'privos-local-runtime' && c.Container === 'app-cluster-self'),
	);
});

test('when the driver is not a container there is nothing to join for itself, and ensureReady still succeeds', async () => {
	const { service, dockerode, staged } = await setup({ selfContainerId: 'not-a-container', selfIsContainer: false });
	const ready = await service.ensureReady(baseEnsureReadyRequest({}, staged.digest));
	assert.equal(ready.state, 'READY');
	assert.equal(dockerode.networkConnects.some((c) => c.Container === 'not-a-container'), false);
});

test('an existing internal privos-local-runtime network is reconciled to non-internal, not left silently wrong', async () => {
	const { service, dockerode, staged } = await setup();
	await dockerode.createNetwork({ Name: 'privos-local-runtime', Internal: true });
	assert.equal(dockerode.networks.get('privos-local-runtime')?.Internal, true);

	await service.ensureReady(baseEnsureReadyRequest({}, staged.digest));

	assert.equal(dockerode.networks.get('privos-local-runtime')?.Internal, false);
	assert.deepEqual(dockerode.networkRemoves, ['privos-local-runtime']);
});

test('ensureNetwork memoizes an in-flight reconcile: two concurrent callers share one inspect/remove/create sequence', async () => {
	const { service, dockerode } = await setup();
	await dockerode.createNetwork({ Name: 'privos-local-runtime', Internal: true });
	const runtimeService = service as unknown as { ensureNetwork(): Promise<void> };

	// Both calls are issued back-to-back with no `await` in between, so
	// without memoization each would independently see the stale `Internal:
	// true` network and run its own disconnect/remove/create — the array
	// below would then hold the name twice instead of once.
	await Promise.all([runtimeService.ensureNetwork(), runtimeService.ensureNetwork()]);

	assert.deepEqual(dockerode.networkRemoves, ['privos-local-runtime']);
	assert.equal(dockerode.networks.get('privos-local-runtime')?.Internal, false);
});

test('reconciling an internal network first disconnects every attached endpoint, including this process itself', async () => {
	const { service, dockerode, staged } = await setup({ selfContainerId: 'app-cluster-self' });
	await dockerode.createNetwork({ Name: 'privos-local-runtime', Internal: true });
	await dockerode.getNetwork('privos-local-runtime').connect({ Container: 'app-cluster-self' });

	await service.ensureReady(baseEnsureReadyRequest({}, staged.digest));

	assert.ok(dockerode.networkDisconnects.some((d) => d.network === 'privos-local-runtime' && d.Container === 'app-cluster-self'));
	assert.equal(dockerode.networks.get('privos-local-runtime')?.Internal, false);
});

// Docker has no "flip Internal in place" op, so a stale internal network is
// fixed by disconnect-everything -> remove -> recreate. Without a reattach
// pass, any OTHER endpoint the reconcile disconnected (not just this
// process's own container) would stay silently detached from the recreated
// network forever.
test('reconciling an internal network re-attaches every endpoint it disconnected, not only this process itself', async () => {
	const { service, dockerode, staged } = await setup();
	await dockerode.createNetwork({ Name: 'privos-local-runtime', Internal: true });
	dockerode.containers.set('other-app', {
		Id: 'other-app-id',
		Image: 'other-app-image',
		Config: { Image: 'other-app-image', Labels: {} },
		HostConfig: {},
		NetworkSettings: { Networks: {} },
		Mounts: [],
		State: { Running: true },
	});
	await dockerode.getNetwork('privos-local-runtime').connect({ Container: 'other-app-id' });

	await service.ensureReady(baseEnsureReadyRequest({}, staged.digest));

	assert.equal(dockerode.networks.get('privos-local-runtime')?.Internal, false);
	assert.ok(
		dockerode.networkConnects.some((c) => c.network === 'privos-local-runtime' && c.Container === 'other-app-id'),
		'the disconnected endpoint must be reconnected once the network is recreated',
	);
});

// The SDK inside the app container resolves its outbound identity mode once
// at process boot by checking whether the broker's identity socket exists.
// Registering the broker binding after `start()` can leave an ACTIVE app
// with no outbound identity for its entire lifetime.
test('the broker binding is registered before the container is started', async () => {
	const { service, dockerode, staged, broker } = await setup();
	const order: string[] = [];

	const originalRegisterProvisioningV3 = broker.registerProvisioningV3.bind(broker);
	broker.registerProvisioningV3 = (async (binding: Parameters<typeof originalRegisterProvisioningV3>[0]) => {
		order.push('register');
		return originalRegisterProvisioningV3(binding);
	}) as typeof broker.registerProvisioningV3;

	const originalGetContainer = dockerode.getContainer.bind(dockerode);
	dockerode.getContainer = ((idOrName: string) => {
		const handle = originalGetContainer(idOrName);
		return { ...handle, start: async () => { order.push('start'); return handle.start(); } };
	}) as typeof dockerode.getContainer;

	await service.ensureReady(baseEnsureReadyRequest({}, staged.digest));

	assert.deepEqual(order, ['register', 'start']);
});

// A ledger record written before `replicaId` existed on this record shape has
// no value for it at all — `RuntimeLedger` backfills it on read, but REMOVE
// and ACTIVATE must actually complete off that backfilled record, not just
// avoid a `path.join(root, undefined)` crash and then fail some other way.
function rewriteLedgerRecord(stateDir: string, runtimeId: string, mutate: (record: Record<string, unknown>) => void): void {
	const ledgerPath = path.join(stateDir, 'runtimes.json');
	const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as { byRuntimeId: Record<string, Record<string, unknown>> };
	mutate(raw.byRuntimeId[runtimeId]!);
	fs.writeFileSync(ledgerPath, JSON.stringify(raw));
}

test('REMOVE does not throw for a pre-upgrade ledger record with no replicaId', async () => {
	const { service, dockerode, ledger, staged, stateDir } = await setup();
	const request = baseEnsureReadyRequest({}, staged.digest);
	const ready = await service.ensureReady(request);

	rewriteLedgerRecord(stateDir, ready.runtime_id, (record) => { delete record.replicaId; });

	await assert.doesNotReject(() =>
		service.remove({
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
		}),
	);
	assert.equal(dockerode.containers.size, 0);
	assert.equal(ledger.getByRuntimeId(ready.runtime_id), null);
});

test('ACTIVATE succeeds off a pre-upgrade ledger record with no replicaId once its container is already gone', async () => {
	const { service, dockerode, staged, stateDir } = await setup();
	const request = baseEnsureReadyRequest({}, staged.digest);
	const ready = await service.ensureReady(request);

	// The exact state a genuinely pre-upgrade record is in: the ledger row
	// predates `replicaId` entirely, and its container (from before this
	// driver ever mounted a broker directory) is already gone.
	dockerode.containers.clear();
	rewriteLedgerRecord(stateDir, ready.runtime_id, (record) => { delete record.replicaId; });

	const activation = {
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

	const active = await service.activate(activation);
	assert.equal(active.state, 'ACTIVE');
	assert.equal(dockerode.containers.size, 1);
});

// The Hub persists a runtime only after it accepted READY. An install it
// rejected at readiness therefore never gets a REMOVE from its uninstall — only
// the artifact erase — and until this backstop the PREACTIVATION container, its
// broker directory and the ledger record outlived the install on the customer's
// host (drake-dev, 2026-09-13, install attempts 2 and 3).
test('removeArtifact tears down a never-activated runtime on that artifact before erasing it: container, broker dir, ledger row', async () => {
	const { service, dockerode, ledger, staged, brokerRoot, artifactStore } = await setup();
	const request = baseEnsureReadyRequest({}, staged.digest);
	const ready = await service.ensureReady(request);
	const replicaId = ledger.getByRuntimeId(ready.runtime_id)!.replicaId;
	assert.equal(fs.existsSync(path.join(brokerRoot, replicaId)), true);

	const result = await service.removeArtifact(staged.digest);

	assert.deepEqual({ digest: result.digest, state: result.state, removed: result.removed }, { digest: staged.digest, state: 'ABSENT', removed: true });
	assert.equal(dockerode.containers.size, 0);
	assert.equal(ledger.getByRuntimeId(ready.runtime_id), null);
	assert.equal(fs.existsSync(path.join(brokerRoot, replicaId)), false);
	assert.equal(await artifactStore.resolve(staged.digest), null);
});

test('removeArtifact leaves an activated runtime alone — the Hub knows it and REMOVEs it explicitly', async () => {
	const { service, dockerode, ledger, staged } = await setup();
	const request = baseEnsureReadyRequest({}, staged.digest);
	const ready = await service.ensureReady(request);
	await service.activate({
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
	});

	await service.removeArtifact(staged.digest);

	assert.equal(dockerode.containers.size, 1);
	assert.equal(ledger.getByRuntimeId(ready.runtime_id)?.state, 'ACTIVE');
});
