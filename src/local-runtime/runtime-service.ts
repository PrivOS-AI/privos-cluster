/**
 * `ensureReady` / `status` / `activate` / `remove` for the
 * `privos-local-runtime-driver-v1` ABI — TS port of
 * `infra/local-runtime-driver/privos_local_runtime_driver/runtime.py`, on top
 * of this repo's `ArtifactStore` (replaces the Python driver's
 * shared-filesystem `artifact.path` re-open) and `RuntimeLedger`.
 *
 * Container hardening mirrors the reference driver exactly: no host mounts,
 * no Docker socket, read-only root + bounded tmpfs, dropped capabilities,
 * memory/cpu from `runtime_spec.resources`, `restart: unless-stopped`, never
 * published on a host port, attached only to the dedicated private local-runtime
 * network (never the community stack network). `artifact.path` is hash-bound
 * into `ensure_ready_request_hash` and echoed unchanged in the persisted
 * request, but is NEVER opened here — the artifact is resolved by
 * `artifact.digest` from `ArtifactStore`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type Docker from 'dockerode';

import {
	AFFINITY_FIELDS,
	affinityFromRequest,
	canonicalHash,
	type ActivateRequest,
	type ActiveEvidence,
	type Affinity,
	type AbsentEvidence,
	type EnsureReadyRequest,
	type ReadyEvidence,
	type RemoveRequest,
	validateActivate,
	validateActive,
	validateAbsent,
	validateEnsureReady,
	validateReady,
	validateRemove,
} from './abi-schema.js';
import type { ArtifactStore, StagedArtifactRecord } from './artifact-store.js';
import { buildLocalRuntimeBinding, LOCAL_RUNTIME_BROKER_LABELS, type LocalRuntimeBrokerBinding, type LocalRuntimeBrokerContext } from './broker-binding.js';
import { dispatchTrustEnv, sortedCanonical } from './dispatch-trust-env.js';
import { AffinityConflict, ArtifactNotStaged, RuntimeNotFound, RuntimeUnavailable } from './errors.js';
import { RuntimeLedger, type RuntimeRecord } from './ledger.js';
import type { McpBrokerManager } from '../services/mcp-broker.js';

export const DRIVER_ABI = 'privos-local-runtime-driver-v1';
export const SUPERVISOR = 'DOCKER_UNLESS_STOPPED';
export const LABEL_PREFIX = 'privos.local-runtime';
export const RUNTIME_ID_RE = /^local-runtime-[0-9a-f]{32}$/;
/** Where the MANAGED identity broker's per-replica directory is bind-mounted inside every container — must match `McpBrokerManager`'s own hardcoded target. */
const BROKER_MOUNT_TARGET = '/run/privos';

export interface RuntimeServiceConfig {
	/** Dedicated private bridge network every local-runtime container attaches to — never the community stack network. Non-internal (apps may reach the Internet) — see `ensureNetworkInternal`. */
	privateNetwork: string;
	pidsLimit: number;
	readyTimeoutSeconds: number;
	/** Overrides how this process finds its own container (defaults to the hostname Docker assigns). */
	selfContainerId?: string;
	/** This App Cluster's own state dir — where the Hub-assigned cluster id is persisted at pairing (`readPairedClusterId`). */
	stateDir: string;
	/** Used only before this cluster has ever paired (mirrors `FLEET_CLUSTER_ID`). */
	fallbackClusterId: string;
	/** This driver's node identity in the broker attestation's `iss` (mirrors `FLEET_NODE_ID ?? 'local-node'`). */
	nodeId: string;
	/** The Hub's public origin (`resolveHubOrigin`) — handed to the app over the attested broker socket response, never as an ABI env field. */
	hubOrigin: string;
	/** Root directory the MANAGED identity broker binds every replica directory under (`McpBrokerManager`'s own root) — used only to sweep orphan directories with no matching ledger record. */
	brokerRoot: string;
}

function computeRuntimeId(request: EnsureReadyRequest | Affinity): string {
	const affinity = affinityFromRequest(request as Affinity);
	const digest = createHash('sha256').update(JSON.stringify(sortedCanonical(affinity))).digest('hex');
	return `local-runtime-${digest.slice(0, 32)}`;
}

function endpointFor(runtimeId: string): string {
	const hex = runtimeId.slice('local-runtime-'.length);
	return `http://${hex}.app-cluster.internal`;
}

interface ContainerPolicy {
	runtimeId: string;
	endpoint: string;
	affinityHash: string;
	containerSpecHash: string;
	createSpec: Docker.ContainerCreateOptions;
	labels: Record<string, string>;
	brokerMount: { source: string; target: string };
}

function policyIdentity(
	request: EnsureReadyRequest,
	artifact: StagedArtifactRecord,
	runtimeId: string,
	network: string,
	pidsLimit: number,
	activation: ActivateRequest | null,
	brokerMountTarget: string,
): Record<string, unknown> {
	return {
		schema_version: 1,
		driver_abi: DRIVER_ABI,
		runtime_id: runtimeId,
		generation_affinity_hash: canonicalHash(affinityFromRequest(request)),
		runtime_authorization_hash: canonicalHash(request.runtime_authorization),
		artifact_digest: artifact.digest,
		image_manifest_digest: artifact.manifestDigest,
		image_config_digest: artifact.configDigest,
		port: request.runtime_spec.port,
		resources: request.runtime_spec.resources,
		pids_limit: pidsLimit,
		authorization_phase: activation ? 'ACTIVE' : 'PREACTIVATION',
		networks: {
			// Non-internal on purpose — a local app may reach the Internet, same as
			// a MANAGED workload — evidenced here so a silent flip back to internal
			// is a detectable affinity change, not a quiet security regression.
			// Local apps reach the Hub over its public origin on this same network,
			// not a dedicated internal bridge — see `RuntimeServiceConfig.hubOrigin`.
			runtime: { name: network, internal: false },
		},
		// Target + read-only only, not the mount source: the source is the
		// per-replica broker directory (`root/replicaId`), and `replicaId` is
		// minted BY the same `ledger.claim()` call this hash is an input to —
		// hashing it here would make every replay look like a fresh affinity.
		// The actual mount (source included) is still verified field-exact on
		// every reconcile by `assertContainerMatchesPolicy`, just not folded
		// into this pre-claim hash. The broker label set has the same
		// replica-id instability and is verified the same way, for the same
		// reason.
		broker_mount_target: brokerMountTarget,
		broker_mount_readonly: true,
		...(activation
			? {
					activation_request_hash: canonicalHash(activation),
					runtime_resource_inventory_hash: activation.runtime_resource_inventory_hash,
					runtime_approval_receipt_hash: activation.runtime_approval_receipt_hash,
					runtime_authorization_epoch: activation.runtime_authorization_epoch,
				}
			: {}),
	};
}

/** The unprivileged fallback for an image that declares no user, or declares root. */
const FALLBACK_USER = '65532:65532';

/**
 * Run as the user the image was built for. Overriding it with an arbitrary uid
 * breaks any image whose files are not world-readable — which is most of them,
 * and every one built `--chown` to its own runtime user. Root is the one thing
 * never honoured: an image that wants root gets the unprivileged fallback instead.
 */
function containerUser(artifact: StagedArtifactRecord): string {
	const declared = artifact.imageUser?.trim();
	if (!declared) return FALLBACK_USER;
	const [user] = declared.split(':');
	if (user === '' || user === 'root' || user === '0') return FALLBACK_USER;
	return declared;
}

function buildPolicy(
	request: EnsureReadyRequest,
	artifact: StagedArtifactRecord,
	config: RuntimeServiceConfig,
	activation: ActivateRequest | null,
	brokerMount: { source: string; target: string },
	binding: LocalRuntimeBrokerBinding,
): ContainerPolicy {
	const runtimeId = computeRuntimeId(request);
	const endpoint = endpointFor(runtimeId);
	const affinityHash = canonicalHash(affinityFromRequest(request));
	const mcpLabels = LOCAL_RUNTIME_BROKER_LABELS(binding);
	const identity = policyIdentity(
		request,
		artifact,
		runtimeId,
		config.privateNetwork,
		config.pidsLimit,
		activation,
		brokerMount.target,
	);
	const containerSpecHash = canonicalHash(identity);
	const { memory_mb: memoryMb, cpus, tmp_size_mb: tmpSizeMb } = request.runtime_spec.resources;
	const memoryBytes = memoryMb * 1024 * 1024;
	const port = request.runtime_spec.port;
	const portKey = `${port}/tcp`;

	const labels: Record<string, string> = {
		...mcpLabels,
		[`${LABEL_PREFIX}.managed-by`]: DRIVER_ABI,
		[`${LABEL_PREFIX}.id`]: runtimeId,
		[`${LABEL_PREFIX}.artifact-digest`]: artifact.digest,
		[`${LABEL_PREFIX}.image-config-digest`]: artifact.configDigest,
		[`${LABEL_PREFIX}.generation-affinity-hash`]: affinityHash,
		[`${LABEL_PREFIX}.container-spec-hash`]: containerSpecHash,
		[`${LABEL_PREFIX}.installation-id`]: request.installation_id,
		[`${LABEL_PREFIX}.generation-id`]: request.generation_id,
		[`${LABEL_PREFIX}.authorization-phase`]: activation ? 'ACTIVE' : 'PREACTIVATION',
	};

	const createSpec: Docker.ContainerCreateOptions = {
		name: runtimeId,
		Image: artifact.imageRef,
		Hostname: runtimeId,
		User: containerUser(artifact),
		Env: dispatchTrustEnv(request, activation),
		Labels: labels,
		ExposedPorts: { [portKey]: {} },
		HostConfig: {
			AutoRemove: false,
			Binds: [],
			CapAdd: [],
			CapDrop: ['ALL'],
			Init: true,
			Memory: memoryBytes,
			MemorySwap: memoryBytes,
			// The one host mount this driver ever allows: the MANAGED identity
			// broker's per-replica directory, read-only (the app can attest and
			// read `hubOrigin`/`hubKid`/`hubPublicJwk` off the socket, never write
			// into the broker's own bookkeeping).
			Mounts: [{ Type: 'bind', Source: brokerMount.source, Target: brokerMount.target, ReadOnly: true }],
			NanoCpus: Math.round(cpus * 1_000_000_000),
			// Fair CPU sharing under contention — mirrors the fleet driver's
			// container-manager.ts (1024 = one full share; proportional to cpus).
			CpuShares: Math.round(1024 * cpus),
			NetworkMode: config.privateNetwork,
			OomKillDisable: false,
			PidsLimit: config.pidsLimit,
			PortBindings: {},
			Privileged: false,
			PublishAllPorts: false,
			ReadonlyRootfs: true,
			RestartPolicy: { Name: 'unless-stopped' },
			SecurityOpt: ['no-new-privileges:true'],
			Tmpfs: { '/tmp': `size=${tmpSizeMb}m,mode=1777,nosuid,nodev,noexec` },
		} as Docker.HostConfig,
	};

	return { runtimeId, endpoint, affinityHash, containerSpecHash, createSpec, labels, brokerMount };
}

/** Verifies an inspected container is exactly the deterministic policy container — never a drifted one. Throws `AffinityConflict` on any mismatch. */
function assertContainerMatchesPolicy(container: any, policy: ContainerPolicy, artifact: StagedArtifactRecord): void {
	const verifiedImages = new Set([artifact.configDigest, artifact.manifestDigest]);
	if (!verifiedImages.has(container.Image) || !verifiedImages.has(container.Config?.Image)) {
		throw new AffinityConflict('The deterministic container has a substituted OCI image reference.');
	}
	const labels: Record<string, string> = container.Config?.Labels ?? {};
	for (const [key, value] of Object.entries(policy.labels)) {
		if (labels[key] !== value) throw new AffinityConflict('The deterministic container affinity labels have drifted.');
	}
	const hostConfig = container.HostConfig ?? {};
	if (hostConfig.NetworkMode !== policy.createSpec.HostConfig?.NetworkMode) {
		throw new AffinityConflict('The local runtime is attached outside its private network.');
	}
	if (hostConfig.ReadonlyRootfs !== true) throw new AffinityConflict('The local runtime lost its read-only root policy.');
	if (hostConfig.PortBindings && Object.keys(hostConfig.PortBindings).length > 0) {
		throw new AffinityConflict('The local runtime cannot publish a host port.');
	}
	const binds = hostConfig.Binds ?? [];
	if (Array.isArray(binds) && binds.length > 0) {
		throw new AffinityConflict('The local runtime cannot mount host or managed storage via legacy binds.');
	}
	// Exactly one mount: the read-only MANAGED identity broker bind — never any
	// other host or managed storage.
	const mounts = container.Mounts ?? hostConfig.Mounts ?? [];
	const brokerMountOnly =
		Array.isArray(mounts) &&
		mounts.length === 1 &&
		mounts[0]?.Source === policy.brokerMount.source &&
		mounts[0]?.Destination === policy.brokerMount.target &&
		mounts[0]?.RW === false;
	if (!brokerMountOnly) {
		throw new AffinityConflict('The local runtime must mount exactly the broker identity socket directory, read-only.');
	}
}

function isPolicyMatch(container: any, policy: ContainerPolicy, artifact: StagedArtifactRecord): boolean {
	try {
		assertContainerMatchesPolicy(container, policy, artifact);
		return true;
	} catch {
		return false;
	}
}

export interface ReadinessProbe {
	waitReady(host: string, port: number, timeoutSeconds: number): Promise<void>;
}

class TcpReadinessProbe implements ReadinessProbe {
	async waitReady(host: string, port: number, timeoutSeconds: number): Promise<void> {
		const deadline = Date.now() + timeoutSeconds * 1000;
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				await new Promise<void>((resolve, reject) => {
					const socket = net.connect({ host, port, timeout: 1000 }, () => {
						socket.end();
						resolve();
					});
					socket.on('error', reject);
					socket.on('timeout', () => { socket.destroy(); reject(new Error('connect timeout')); });
				});
				return;
			} catch (err) {
				lastError = err;
				await new Promise((r) => setTimeout(r, 250));
			}
		}
		throw new RuntimeUnavailable(`the local runtime did not become TCP-ready: ${(lastError as Error)?.message ?? 'timeout'}`);
	}
}

/** Minimal structured-logging surface `rebindActiveRuntimes` needs — a pino instance (`fastify.log`) already satisfies it. */
export interface RuntimeServiceLogger {
	warn: (...args: unknown[]) => void;
}

const noopLogger: RuntimeServiceLogger = { warn: () => {} };

export class RuntimeService {
	private readonly readiness: ReadinessProbe;
	private readonly logger: RuntimeServiceLogger;
	private networkEnsured = false;
	/** Memoizes a single in-flight `ensureNetwork()` reconcile so concurrent callers share it instead of each running their own inspect/remove/create sequence. Cleared on rejection so a later call retries. */
	private ensureNetworkPromise: Promise<void> | undefined;

	constructor(
		private readonly docker: Docker,
		private readonly ledger: RuntimeLedger,
		private readonly artifactStore: ArtifactStore,
		private readonly broker: McpBrokerManager,
		private readonly config: RuntimeServiceConfig,
		private readonly clock: () => number = Date.now,
		readinessProbe?: ReadinessProbe,
		logger?: RuntimeServiceLogger,
	) {
		this.readiness = readinessProbe ?? new TcpReadinessProbe();
		this.logger = logger ?? noopLogger;
	}

	private now(): number {
		const now = Math.floor(this.clock() / 1000);
		if (now <= 0) throw new RuntimeUnavailable('the driver clock is invalid');
		return now;
	}

	private brokerContext(): LocalRuntimeBrokerContext {
		return {
			stateDir: this.config.stateDir,
			fallbackClusterId: this.config.fallbackClusterId,
			nodeId: this.config.nodeId,
			hubOrigin: this.config.hubOrigin,
			networkName: this.config.privateNetwork,
		};
	}

	private async ensureNetwork(): Promise<void> {
		if (this.networkEnsured) return;
		if (!this.ensureNetworkPromise) {
			this.ensureNetworkPromise = this.ensureNetworkOnce().finally(() => {
				this.ensureNetworkPromise = undefined;
			});
		}
		return this.ensureNetworkPromise;
	}

	private async ensureNetworkOnce(): Promise<void> {
		// Non-internal — a local app may reach the Internet. drake already has
		// this network `Internal: true` from before that, so the mismatch branch
		// below is the one actually exercised there, not the create branch.
		// Local apps reach the Hub over its public origin on this same network —
		// there is no separate Hub bridge.
		await this.ensureNetworkInternal(this.config.privateNetwork, false);
		await this.attachSelfToNetwork(this.config.privateNetwork);
		this.networkEnsured = true;
	}

	/**
	 * Ensures network `name` exists with exactly the given `internal` flag.
	 * Docker refuses to flip `Internal` on an existing network, so a mismatch
	 * is reconciled instead of swallowed as a 409: every endpoint (including
	 * this process's own container, if attached) is disconnected, the network
	 * is removed and recreated, and then every one of those same endpoints is
	 * reattached — never left silently wrong (a swallowed 409 would do that
	 * forever) and never left silently detached (an app container that was on
	 * the network before the flip must still be able to reach it after).
	 */
	private async ensureNetworkInternal(name: string, internal: boolean): Promise<void> {
		let info: any = null;
		try {
			info = await this.docker.getNetwork(name).inspect();
		} catch (err: any) {
			if (err?.statusCode !== 404) throw new RuntimeUnavailable(`failed to inspect the ${name} network: ${err?.message ?? String(err)}`);
		}
		let reattach: string[] = [];
		if (info && Boolean(info.Internal) !== internal) {
			reattach = Object.keys(info.Containers ?? {});
			for (const containerId of reattach) {
				await this.docker.getNetwork(name).disconnect({ Container: containerId, Force: true }).catch((err: any) => {
					if (err?.statusCode !== 404) throw new RuntimeUnavailable(`failed to disconnect ${containerId} while reconciling the ${name} network: ${err?.message ?? String(err)}`);
				});
			}
			await this.docker.getNetwork(name).remove().catch((err: any) => {
				if (err?.statusCode !== 404) throw new RuntimeUnavailable(`failed to remove the stale ${name} network: ${err?.message ?? String(err)}`);
			});
			info = null;
		}
		if (!info) {
			try {
				await this.docker.createNetwork({ Name: name, Driver: 'bridge', Internal: internal, CheckDuplicate: true });
			} catch (err: any) {
				if (err?.statusCode !== 409) throw new RuntimeUnavailable(`failed to ensure the ${name} network: ${err?.message ?? String(err)}`);
			}
		}
		for (const containerId of reattach) await this.attachNetwork(name, containerId);
	}

	/**
	 * The readiness probe and MCP forwarding both dial the app's address on the
	 * private network, so this process has to be on that network too. When it
	 * runs as a container (the self-hosted compose stack), Docker only routes
	 * between containers that share a network — join it. A process that is not
	 * a container (host networking) reaches bridge addresses directly and has
	 * nothing to join.
	 */
	private async attachSelfToNetwork(network: string): Promise<void> {
		const self = this.config.selfContainerId ?? os.hostname();
		try {
			await this.docker.getContainer(self).inspect();
		} catch (err: any) {
			if (err?.statusCode === 404) return;
			throw new RuntimeUnavailable(`failed to identify this process's own container: ${err?.message ?? String(err)}`);
		}
		await this.attachNetwork(network, self);
	}

	/** Idempotently attaches `containerId` to network `name` — tolerates "already attached" the way Docker reports it, and a container that no longer exists (a REMOVE can race a network reconcile's reattach pass). */
	private async attachNetwork(name: string, containerId: string): Promise<void> {
		try {
			await this.docker.getNetwork(name).connect({ Container: containerId });
		} catch (err: any) {
			// 403 is Docker's "endpoint already exists" for this container; 409 means
			// the same; 404 means the container is already gone — nothing to attach.
			if (err?.statusCode === 403 || err?.statusCode === 409 || err?.statusCode === 404) return;
			throw new RuntimeUnavailable(`failed to join the ${name} network: ${err?.message ?? String(err)}`);
		}
	}

	private async inspectByName(name: string): Promise<any | null> {
		try {
			return await this.docker.getContainer(name).inspect();
		} catch (err: any) {
			if (err?.statusCode === 404) return null;
			throw new RuntimeUnavailable(`docker container inspection failed: ${err?.message ?? String(err)}`);
		}
	}

	private async removeContainerVerified(name: string, policy: ContainerPolicy, artifact: StagedArtifactRecord): Promise<void> {
		const container = await this.inspectByName(name);
		if (!container) return;
		assertContainerMatchesPolicy(container, policy, artifact);
		if (container.State?.Running) {
			await this.docker.getContainer(container.Id).stop({ t: 10 }).catch((err: any) => {
				if (err?.statusCode !== 304 && err?.statusCode !== 404) throw new RuntimeUnavailable(`failed to stop the local runtime container: ${err?.message ?? String(err)}`);
			});
		}
		await this.docker.getContainer(container.Id).remove({ force: false, v: false }).catch((err: any) => {
			if (err?.statusCode !== 404) throw new RuntimeUnavailable(`failed to remove the local runtime container: ${err?.message ?? String(err)}`);
		});
		if (await this.inspectByName(name)) throw new RuntimeUnavailable('Docker did not remove the exact preactivation container.');
	}

	/**
	 * Creates (if absent), verifies, (re)registers the broker binding, starts
	 * (if not already running), and TCP-probes the deterministic policy
	 * container. Returns its container id.
	 *
	 * The broker binding is registered BEFORE the container is (re)started:
	 * the SDK resolves its outbound identity socket once at process boot, so
	 * registering after `start()` can leave an ACTIVE app with no outbound
	 * identity for its entire lifetime. `assertContainerMatchesPolicy` needs
	 * no running container (image/labels/host config/mounts are all set at
	 * create time), so it runs first and keeps the broker registration
	 * fail-closed: a policy-mismatched container never gets a binding.
	 * `registerBroker` is called on every reconciliation, not just a fresh
	 * create — the broker's socket is an in-memory `net.Server` that does not
	 * survive this process restarting, so an already-running container still
	 * needs its binding re-established, just with no "before boot" ordering
	 * left to preserve.
	 */
	private async reconcileContainer(
		policy: ContainerPolicy,
		artifact: StagedArtifactRecord,
		registerBroker: (dockerContainerId: string) => Promise<void>,
	): Promise<string> {
		await this.ensureNetwork();
		let container = await this.inspectByName(policy.runtimeId);
		if (!container) {
			await this.docker.createContainer(policy.createSpec);
			container = await this.inspectByName(policy.runtimeId);
			if (!container) throw new RuntimeUnavailable('Docker did not persist the deterministic container.');
		}
		assertContainerMatchesPolicy(container, policy, artifact);
		if (!container.State?.Running) {
			await registerBroker(container.Id);
			await this.docker.getContainer(container.Id).start().catch((err: any) => {
				if (err?.statusCode !== 304) throw new RuntimeUnavailable(`failed to start the local runtime container: ${err?.message ?? String(err)}`);
			});
			container = await this.inspectByName(policy.runtimeId);
			if (!container) throw new RuntimeUnavailable('the local runtime container disappeared after start');
		} else {
			await registerBroker(container.Id);
		}
		const address = container.NetworkSettings?.Networks?.[this.config.privateNetwork]?.IPAddress;
		if (!address) throw new RuntimeUnavailable('the local runtime has no private container address');
		await this.readiness.waitReady(address, policy.createSpec.ExposedPorts ? Number(Object.keys(policy.createSpec.ExposedPorts)[0]!.split('/')[0]) : 0, this.config.readyTimeoutSeconds);
		return container.Id;
	}

	private resolveStagedArtifact(digest: string): StagedArtifactRecord {
		const staged = this.artifactStore.resolve(digest);
		if (!staged) throw new ArtifactNotStaged();
		return staged;
	}

	/** Core ENSURE_READY logic, unlocked — callers must already hold `ledger.withRuntimeLock`. */
	private async ensureReadyLocked(request: EnsureReadyRequest): Promise<ReadyEvidence> {
		const artifact = this.resolveStagedArtifact(request.artifact.digest);
		const runtimeId = computeRuntimeId(request);
		const requestJson = JSON.stringify(sortedCanonical(request));
		const requestHash = canonicalHash(request);
		// The broker mount's host-side source path is `brokerRoot/replicaId`,
		// and `replicaId` is minted BY the `claim()` call below — so the
		// pre-claim hash input can only ever see the fixed mount target (see
		// `policyIdentity`'s doc comment), never the not-yet-known source.
		const preClaimContainerSpecHash = canonicalHash(
			policyIdentity(request, artifact, runtimeId, this.config.privateNetwork, this.config.pidsLimit, null, BROKER_MOUNT_TARGET),
		);

		// The runtime id covers the affinity fields only, so a retried ENSURE_READY with a
		// corrected runtime spec (port, resources) lands on the same id as the candidate it
		// replaces. A candidate that never activated is not live — nothing routes to it — so
		// a changed request tears it down and claims afresh; an activating or ACTIVE runtime
		// is never replaced here (`ledger.claim` still refuses a mismatch against it).
		const prior = this.ledger.getByRuntimeId(runtimeId);
		if (prior && (prior.state === 'CLAIMED' || prior.state === 'READY') && prior.requestHash !== requestHash) {
			await this.teardownRecorded(prior);
		}

		let record: RuntimeRecord = this.ledger.claim({
			generationId: request.generation_id,
			installationId: request.installation_id,
			generationNumber: request.generation_number,
			requestHash,
			requestJson,
			runtimeId,
			artifactDigest: artifact.digest,
			imageManifestDigest: artifact.manifestDigest,
			imageConfigDigest: artifact.configDigest,
			containerSpecHash: preClaimContainerSpecHash,
			now: this.now(),
		});

		// EXACT_READY_REPLAY: once READY evidence is durable, ensureReady/status
		// always replay the exact stored document — including after activation
		// (the ledger only ever ADDS activation fields to the record; it never
		// clears `readyResponseJson`, so this covers every later replay too).
		if (record.readyResponseJson) {
			return validateReady(JSON.parse(record.readyResponseJson));
		}

		const brokerMount = await this.broker.prepare(record.replicaId);
		const binding = buildLocalRuntimeBinding(this.brokerContext(), request, artifact.digest, runtimeId, record.replicaId, '', null);
		const policy = buildPolicy(request, artifact, this.config, null, brokerMount, binding);
		const containerId = await this.reconcileContainer(policy, artifact, async (dockerContainerId) => {
			await this.broker.registerProvisioningV3({ ...binding, dockerContainerId, runtimeResourceInventoryHash: undefined });
			this.ledger.recordBrokerRegistered(runtimeId, this.now());
		});
		record = this.ledger.recordContainer(runtimeId, requestHash, containerId, this.now());

		const readyAt = this.now();
		const readyWithoutHash: Record<string, unknown> = {
			protocol_version: 3,
			state: 'READY',
			runtime_id: policy.runtimeId,
			...affinityFromRequest(request),
			artifact_digest: artifact.digest,
			endpoint: policy.endpoint,
			supervisor: SUPERVISOR,
			ready_at: readyAt,
		};
		const response = { ...readyWithoutHash, driver_evidence_hash: canonicalHash(readyWithoutHash) };
		const evidence = {
			schema_version: 1,
			ready: readyWithoutHash,
			supervisor_evidence: {
				driver_abi: DRIVER_ABI,
				container_name: policy.runtimeId,
				container_spec_hash: policy.containerSpecHash,
				generation_affinity_hash: policy.affinityHash,
				image_manifest_digest: artifact.manifestDigest,
				image_config_digest: artifact.configDigest,
				network: this.config.privateNetwork,
				restart_policy: 'unless-stopped',
			},
		};
		const responseJson = JSON.stringify(sortedCanonical(response));
		const evidenceJson = JSON.stringify(sortedCanonical(evidence));
		const marked = this.ledger.markReady(runtimeId, requestHash, responseJson, evidenceJson, readyAt);
		return validateReady(JSON.parse(marked.readyResponseJson!));
	}

	async ensureReady(rawRequest: unknown): Promise<ReadyEvidence> {
		const request = validateEnsureReady(rawRequest);
		const runtimeId = computeRuntimeId(request);
		return this.ledger.withRuntimeLock(runtimeId, () => this.ensureReadyLocked(request));
	}

	async status(runtimeId: string): Promise<ReadyEvidence> {
		if (!RUNTIME_ID_RE.test(runtimeId)) throw new RuntimeNotFound();
		return this.ledger.withRuntimeLock(runtimeId, async () => {
			const record = this.ledger.getByRuntimeId(runtimeId);
			if (!record) throw new RuntimeNotFound();
			const request = validateEnsureReady(JSON.parse(record.requestJson));
			return this.ensureReadyLocked(request);
		});
	}

	/** The provisioning/active broker mount for a replica the broker directory is already known to exist for — a pure path join, no `broker.prepare()` I/O (used only to reconstruct a policy for verification, never to create anything). */
	private brokerMountFor(replicaId: string): { source: string; target: string } {
		return { source: path.join(this.config.brokerRoot, replicaId), target: BROKER_MOUNT_TARGET };
	}

	async activate(rawRequest: unknown): Promise<ActiveEvidence> {
		const activation = validateActivate(rawRequest);
		return this.ledger.withRuntimeLock(activation.runtime_id, async () => {
			const record = this.ledger.getByRuntimeId(activation.runtime_id);
			if (!record) throw new RuntimeNotFound();
			const request = validateEnsureReady(JSON.parse(record.requestJson));
			const artifact = this.resolveStagedArtifact(request.artifact.digest);
			const provisioningBinding = buildLocalRuntimeBinding(
				this.brokerContext(), request, artifact.digest, activation.runtime_id, record.replicaId, '', null,
			);
			const preactivationPolicy = buildPolicy(request, artifact, this.config, null, this.brokerMountFor(record.replicaId), provisioningBinding);
			this.assertActivationAffinity(activation, request, preactivationPolicy, artifact);

			// READY must be durable and the preactivation container reconciled
			// before the irreversible activation intent is claimed.
			await this.ensureReadyLocked(request);

			// Same replicaId chicken-and-egg as `ensureReadyLocked`: the active
			// replica's broker directory is `brokerRoot/activeReplicaId`, and
			// `activeReplicaId` is minted BY `claimActivation` below.
			const preClaimActiveContainerSpecHash = canonicalHash(
				policyIdentity(request, artifact, activation.runtime_id, this.config.privateNetwork, this.config.pidsLimit, activation, BROKER_MOUNT_TARGET),
			);
			const claimed = this.ledger.claimActivation({
				runtimeId: activation.runtime_id,
				requestHash: canonicalHash(request),
				activationRequestHash: canonicalHash(activation),
				activationRequestJson: JSON.stringify(sortedCanonical(activation)),
				activeContainerSpecHash: preClaimActiveContainerSpecHash,
				now: this.now(),
			});

			if (claimed.state === 'ACTIVE' && claimed.activeResponseJson) {
				return validateActive(JSON.parse(claimed.activeResponseJson));
			}

			const activeReplicaId = claimed.activeReplicaId!;
			const activeBrokerMount = await this.broker.prepare(activeReplicaId);
			const activeBinding = buildLocalRuntimeBinding(
				this.brokerContext(), request, artifact.digest, activation.runtime_id, activeReplicaId, '', activation,
			);
			const activePolicy = buildPolicy(request, artifact, this.config, activation, activeBrokerMount, activeBinding);

			// The preactivation and active-phase containers share one Docker name
			// (`runtimeId` does not depend on activation), so a crash-retry of an
			// ACTIVATING claim can find the container already swapped to the
			// active-phase policy. Only stop+remove the preactivation container
			// (and its now-superseded broker directory) when it is still actually
			// in the preactivation phase; otherwise this replay just reconciles
			// (verifies + ensures running) the existing one.
			const current = await this.inspectByName(activePolicy.runtimeId);
			const alreadyActivePhase = current !== null && isPolicyMatch(current, activePolicy, artifact);
			if (!alreadyActivePhase) {
				await this.removeContainerVerified(preactivationPolicy.runtimeId, preactivationPolicy, artifact);
				await this.broker.cleanup(record.replicaId);
			}
			const containerId = await this.reconcileContainer(activePolicy, artifact, async (dockerContainerId) => {
				await this.broker.register({ ...activeBinding, dockerContainerId });
				this.ledger.recordBrokerRegistered(activation.runtime_id, this.now());
			});
			this.ledger.recordContainer(activation.runtime_id, canonicalHash(request), containerId, this.now());

			const activationHash = canonicalHash(activation);
			const activeReadyAt = this.now();
			const readyRecord = this.ledger.recordActiveContainerReady({
				runtimeId: activation.runtime_id,
				activationRequestHash: activationHash,
				now: activeReadyAt,
			});

			const activeWithoutHash: Record<string, unknown> = {
				protocol_version: 3,
				state: 'ACTIVE',
				...Object.fromEntries(Object.entries(activation).filter(([k]) => k !== 'protocol_version' && k !== 'operation')),
				unsigned_readiness_disabled: true,
				activated_at: readyRecord.activeContainerReadyAt,
			};
			const response = { ...activeWithoutHash, activation_evidence_hash: canonicalHash(activeWithoutHash) };
			const evidence = {
				schema_version: 1,
				active: activeWithoutHash,
				supervisor_evidence: {
					driver_abi: DRIVER_ABI,
					container_name: activePolicy.runtimeId,
					container_spec_hash: activePolicy.containerSpecHash,
					generation_affinity_hash: activePolicy.affinityHash,
					activation_request_hash: activationHash,
					image_manifest_digest: artifact.manifestDigest,
					image_config_digest: artifact.configDigest,
					network: this.config.privateNetwork,
					restart_policy: 'unless-stopped',
				},
			};
			const marked = this.ledger.markActive({
				runtimeId: activation.runtime_id,
				activationRequestHash: activationHash,
				activeResponseJson: JSON.stringify(sortedCanonical(response)),
				activationEvidenceJson: JSON.stringify(sortedCanonical(evidence)),
				now: this.now(),
			});
			return validateActive(JSON.parse(marked.activeResponseJson!));
		});
	}

	private assertActivationAffinity(
		activation: ActivateRequest,
		request: EnsureReadyRequest,
		policy: ContainerPolicy,
		artifact: StagedArtifactRecord,
	): void {
		if (
			activation.ensure_ready_request_hash !== canonicalHash(request) ||
			activation.runtime_id !== policy.runtimeId ||
			activation.artifact_digest !== artifact.digest ||
			AFFINITY_FIELDS.some((field) => JSON.stringify((activation as any)[field]) !== JSON.stringify((request as any)[field]))
		) {
			throw new AffinityConflict('The activation has different immutable runtime affinity.');
		}
	}

	async remove(rawRequest: unknown): Promise<AbsentEvidence> {
		const request = validateRemove(rawRequest);
		return this.ledger.withRuntimeLock(request.runtime_id, async () => {
			const record = this.ledger.getByRuntimeId(request.runtime_id);
			if (record) {
				if (record.artifactDigest !== request.artifact_digest) {
					throw new AffinityConflict('The REMOVE request does not match the persisted runtime.');
				}
				const persisted = validateEnsureReady(JSON.parse(record.requestJson));
				if (JSON.stringify(affinityFromRequest(persisted)) !== JSON.stringify(affinityFromRequest(request))) {
					throw new AffinityConflict('The REMOVE request does not match the persisted runtime.');
				}
				await this.teardownRecorded(record);
			}
			if (await this.inspectByName(request.runtime_id)) throw new RuntimeUnavailable('Docker did not remove the exact supervised container.');
			if (this.ledger.getByRuntimeId(request.runtime_id)) throw new RuntimeUnavailable('the runtime record survived removal');

			const checkedAt = this.now();
			const evidenceWithoutHash: Record<string, unknown> = {
				protocol_version: 3,
				state: 'ABSENT',
				...affinityFromRequest(request),
				runtime_id: request.runtime_id,
				artifact_digest: request.artifact_digest,
				checked_at: checkedAt,
			};
			const response = { ...evidenceWithoutHash, removal_evidence_hash: canonicalHash(evidenceWithoutHash) };
			return validateAbsent(response);
		});
	}

	/** Stops and removes the runtime's container, its broker directories and its ledger row. Caller holds the runtime lock. */
	private async teardownRecorded(record: RuntimeRecord): Promise<void> {
		const container = await this.inspectByName(record.runtimeId);
		if (container) {
			if (container.State?.Running) {
				await this.docker.getContainer(container.Id).stop({ t: 10 }).catch((err: any) => {
					if (err?.statusCode !== 304 && err?.statusCode !== 404) throw new RuntimeUnavailable(`failed to stop the local runtime container: ${err?.message ?? String(err)}`);
				});
			}
			await this.docker.getContainer(container.Id).remove({ force: false, v: false }).catch((err: any) => {
				if (err?.statusCode !== 404) throw new RuntimeUnavailable(`failed to remove the local runtime container: ${err?.message ?? String(err)}`);
			});
		}
		// Broker cleanup before the ledger row is dropped: on this
		// ordering, a crash between the two still leaves the ledger row
		// (a required re-run of REMOVE can find and finish it); the
		// reverse order would leak the broker directory forever the
		// moment a crash landed between them.
		await this.broker.cleanup(record.replicaId);
		if (record.activeReplicaId) await this.broker.cleanup(record.activeReplicaId);
		this.ledger.deleteByRuntimeId(record.runtimeId);
	}

	/**
	 * Erases a staged artifact (`DELETE /v3/local-artifacts/:digest`). A runtime
	 * on that artifact whose generation never activated is torn down first: the
	 * Hub only persists a runtime after it accepted READY, so an install it
	 * rejected at readiness never gets a REMOVE from its uninstall — the artifact
	 * erase that uninstall does send is the one signal that the install is dead.
	 * Docker also refuses to remove an image such a container still references,
	 * so without this the erase itself would fail. Activated runtimes are never
	 * touched here: the Hub knows them and REMOVEs them explicitly.
	 */
	async removeArtifact(digest: string): Promise<{ digest: string; state: 'ABSENT'; removed: boolean; checkedAt: number }> {
		for (const record of this.ledger.listRecords()) {
			if (record.artifactDigest !== digest || record.activationRequestHash !== null) continue;
			await this.ledger.withRuntimeLock(record.runtimeId, async () => {
				const current = this.ledger.getByRuntimeId(record.runtimeId);
				if (current && current.activationRequestHash === null) await this.teardownRecorded(current);
			});
		}
		return this.artifactStore.remove(digest);
	}

	/**
	 * Startup reconciliation for local ACTIVE runtimes: the broker's socket is
	 * an in-memory `net.Server` that does not survive this process restarting
	 * (nor a host reboot, which also wipes the tmpfs `/run` the broker
	 * directory lives under), so every ACTIVE record's finalized binding is
	 * re-registered and its app container restarted — the SDK resolves its
	 * dispatch mode once at boot, so a container that never restarts keeps
	 * talking to a socket that no longer exists. Reconciles the runtime network
	 * FIRST, before touching any container: a host reboot or an operator
	 * recreating the network can leave it back on the wrong `Internal` flag,
	 * and every restarted container needs to come back up already on the
	 * correct one, not on whatever the next `ensureReady`/`activate` call
	 * happens to fix later (which may never come, for an already-ACTIVE
	 * generation). Finishes with a sweep of any broker directory with no
	 * matching ledger record (a crash between `prepare()` and the ledger
	 * write, or a REMOVE racing a rebind, would otherwise leak it forever).
	 */
	async rebindActiveRuntimes(): Promise<{ rebound: number; failed: number }> {
		await this.ensureNetwork();
		let rebound = 0;
		let failed = 0;
		for (const record of this.ledger.listActiveRecords()) {
			try {
				await this.rebindOneActiveRuntime(record);
				rebound++;
			} catch (err) {
				failed++;
				this.logger.warn({ runtimeId: record.runtimeId, err }, 'local runtime rebind failed');
			}
		}
		await this.sweepOrphanBrokerDirectories();
		return { rebound, failed };
	}

	private async rebindOneActiveRuntime(record: RuntimeRecord): Promise<void> {
		if (!record.activeReplicaId || !record.containerId || !record.activationRequestJson) {
			throw new RuntimeUnavailable('an ACTIVE record is missing its finalized activation identity');
		}
		const request = validateEnsureReady(JSON.parse(record.requestJson));
		const activation = validateActivate(JSON.parse(record.activationRequestJson));
		const artifact = this.resolveStagedArtifact(request.artifact.digest);
		const binding = buildLocalRuntimeBinding(
			this.brokerContext(), request, artifact.digest, record.runtimeId, record.activeReplicaId, record.containerId, activation,
		);
		try {
			await this.broker.prepare(record.activeReplicaId);
			await this.broker.register(binding);
		} catch (err) {
			// The persisted binding on disk (survives a plain process restart,
			// though never a host reboot — `/run` is tmpfs) disagrees with the one
			// freshly rebuilt from the ledger. Rebuild the broker directory from
			// scratch rather than serve a stale/conflicting attestation forever.
			if (!(err instanceof Error) || !err.message.includes('persisted_mcp_v3_broker_binding_conflict')) throw err;
			await this.broker.cleanup(record.activeReplicaId);
			await this.broker.prepare(record.activeReplicaId);
			await this.broker.register(binding);
		}
		this.ledger.recordBrokerRegistered(record.runtimeId, this.now());
		await this.docker.getContainer(record.containerId).restart().catch((err: any) => {
			if (err?.statusCode !== 404) throw new RuntimeUnavailable(`failed to restart the local runtime container after rebind: ${err?.message ?? String(err)}`);
		});
	}

	private async sweepOrphanBrokerDirectories(): Promise<void> {
		const known = new Set(this.ledger.listKnownReplicaIds());
		// The broker root is shared with MANAGED replicas, which have no ledger
		// record here: any directory a live container still names in its replica
		// label is not an orphan.
		for (const container of await this.docker.listContainers({ all: true, filters: { label: ['privos.mcp.replica'] } })) {
			const replicaId = container.Labels?.['privos.mcp.replica'];
			if (replicaId) known.add(replicaId);
		}
		let entries: string[];
		try {
			entries = await fs.readdir(this.config.brokerRoot);
		} catch (err: any) {
			if (err?.code === 'ENOENT') return;
			throw new RuntimeUnavailable(`failed to sweep the broker root: ${err?.message ?? String(err)}`);
		}
		for (const entry of entries) {
			if (!known.has(entry)) await this.broker.cleanup(entry).catch(() => {});
		}
	}
}
