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

const tmpDirs: string[] = [];
function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-service-test-'));
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

class FakeDockerode {
	networks = new Set<string>();
	containers = new Map<string, FakeContainer>(); // keyed by name
	createContainerCalls = 0;
	removeCalls = 0;

	async createNetwork(opts: { Name: string }): Promise<void> {
		if (this.networks.has(opts.Name)) {
			const err: any = new Error('conflict');
			err.statusCode = 409;
			throw err;
		}
		this.networks.add(opts.Name);
	}

	async createContainer(spec: any): Promise<{ id: string; start: () => Promise<void> }> {
		this.createContainerCalls++;
		const id = `cid-${spec.name}-${this.createContainerCalls}`;
		const record: FakeContainer = {
			Id: id,
			Image: spec.Image,
			Config: { Image: spec.Image, Labels: spec.Labels, User: spec.User },
			HostConfig: spec.HostConfig,
			NetworkSettings: { Networks: { [spec.HostConfig.NetworkMode]: { IPAddress: '10.99.0.5' } } },
			Mounts: [],
			State: { Running: false },
		};
		this.containers.set(spec.name, record);
		return { id, start: async () => { record.State.Running = true; } };
	}

	networkConnects: { network: string; Container: string }[] = [];

	getNetwork(name: string) {
		return {
			connect: async (opts: { Container: string }) => {
				this.networkConnects.push({ network: name, Container: opts.Container });
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
	const service = new RuntimeService(
		dockerode as any,
		ledger,
		artifactStore,
		{ privateNetwork: 'privos-local-runtime', pidsLimit: 128, readyTimeoutSeconds: 5, ...(options.selfContainerId ? { selfContainerId: options.selfContainerId } : {}) },
		() => 1_700_000_000_000,
		instantReadiness,
	);
	return { service, dockerode, ledger, artifactStore, staged, fixture };
}

test('ensureReady stages a valid runtime: READY evidence, no host port, private network, read-only rootfs, no bind mounts', async () => {
	const { service, dockerode, staged } = await setup();
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
	assert.deepEqual(container.Mounts, []);
	assert.equal(container.State.Running, true);
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
	assert.deepEqual(dockerode.networkConnects, [{ network: 'privos-local-runtime', Container: 'app-cluster-self' }]);
});

test('when the driver is not a container there is nothing to join and readiness proceeds', async () => {
	const { service, dockerode, staged } = await setup({ selfContainerId: 'not-a-container', selfIsContainer: false });
	const ready = await service.ensureReady(baseEnsureReadyRequest({}, staged.digest));
	assert.equal(ready.state, 'READY');
	assert.deepEqual(dockerode.networkConnects, []);
});
