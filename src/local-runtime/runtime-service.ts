/**
 * `ensureReady` / `status` / `activate` / `remove` for the
 * `privos-local-runtime-driver-v1` ABI — TS port of
 * `infra/local-runtime-driver/privos_local_runtime_driver/runtime.py`, on top
 * of this repo's `ArtifactStore` (phase 6, replaces the Python driver's
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
import net from 'node:net';

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
import { AffinityConflict, ArtifactNotStaged, RuntimeNotFound, RuntimeUnavailable } from './errors.js';
import { RuntimeLedger, type RuntimeRecord } from './ledger.js';

export const DRIVER_ABI = 'privos-local-runtime-driver-v1';
export const SUPERVISOR = 'DOCKER_UNLESS_STOPPED';
export const LABEL_PREFIX = 'privos.local-runtime';
export const RUNTIME_ID_RE = /^local-runtime-[0-9a-f]{32}$/;

export interface RuntimeServiceConfig {
	/** Dedicated private bridge network every local-runtime container attaches to — never the community stack network. */
	privateNetwork: string;
	pidsLimit: number;
	readyTimeoutSeconds: number;
}

function computeRuntimeId(request: EnsureReadyRequest | Affinity): string {
	const affinity = affinityFromRequest(request as Affinity);
	const digest = createHash('sha256').update(JSON.stringify(sortedCanonical(affinity))).digest('hex');
	return `local-runtime-${digest.slice(0, 32)}`;
}

// Local mirror of the sorted-key canonicalization `security/artifacts.ts`'s
// `canonicalJson` already performs — reused here via the sha256-hex form
// (not base64url) because `_runtime_id` in the reference driver hashes the
// same canonical bytes with a plain hex digest, not the base64url evidence hash.
function sortedCanonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortedCanonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => [k, sortedCanonical(v)]),
		);
	}
	return value;
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
}

function policyIdentity(
	request: EnsureReadyRequest,
	artifact: StagedArtifactRecord,
	runtimeId: string,
	network: string,
	pidsLimit: number,
	activation: ActivateRequest | null,
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
		network,
		port: request.runtime_spec.port,
		resources: request.runtime_spec.resources,
		pids_limit: pidsLimit,
		authorization_phase: activation ? 'ACTIVE' : 'PREACTIVATION',
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

function dispatchTrustEnv(request: EnsureReadyRequest, activation: ActivateRequest | null): string[] {
	const authorization = request.runtime_authorization;
	const trust: Record<string, unknown> = {
		hubKid: authorization.hub_kid,
		hubPublicJwk: authorization.hub_public_jwk,
		affinity: {
			workspaceId: request.workspace_id,
			deploymentId: request.deployment_id,
			mcpAppId: authorization.mcp_app_id,
			executionMode: 'SELF_HOSTED_LOCAL',
			generationId: request.generation_id,
			generationNumber: request.generation_number,
			runtimeInstallationId: request.installation_id,
			manifestDigest: authorization.manifest_digest,
			resourceManifestHash: request.resource_manifest_hash,
			...(activation
				? {
						runtimeResourceInventoryHash: activation.runtime_resource_inventory_hash,
						runtimeApprovalReceiptHash: activation.runtime_approval_receipt_hash,
						runtimeAuthorizationEpoch: activation.runtime_authorization_epoch,
					}
				: {}),
		},
	};
	return [
		'PRIVOS_RUNTIME_SECURITY_MODE=runtime-v3',
		`PRIVOS_RUNTIME_DISPATCH_TRUST_V3=${JSON.stringify(sortedCanonical(trust))}`,
		`PRIVOS_RUNTIME_ALLOW_UNSIGNED_PREACTIVATION_READINESS=${activation ? 'false' : 'true'}`,
	];
}

function buildPolicy(
	request: EnsureReadyRequest,
	artifact: StagedArtifactRecord,
	config: RuntimeServiceConfig,
	activation: ActivateRequest | null,
): ContainerPolicy {
	const runtimeId = computeRuntimeId(request);
	const endpoint = endpointFor(runtimeId);
	const affinityHash = canonicalHash(affinityFromRequest(request));
	const identity = policyIdentity(request, artifact, runtimeId, config.privateNetwork, config.pidsLimit, activation);
	const containerSpecHash = canonicalHash(identity);
	const { memory_mb: memoryMb, cpus, tmp_size_mb: tmpSizeMb } = request.runtime_spec.resources;
	const memoryBytes = memoryMb * 1024 * 1024;
	const port = request.runtime_spec.port;
	const portKey = `${port}/tcp`;

	const labels: Record<string, string> = {
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
		User: '65532:65532',
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
			Mounts: [],
			NanoCpus: Math.round(cpus * 1_000_000_000),
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

	return { runtimeId, endpoint, affinityHash, containerSpecHash, createSpec, labels };
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
	const mounts = container.Mounts ?? hostConfig.Mounts ?? [];
	if ((Array.isArray(binds) && binds.length > 0) || (Array.isArray(mounts) && mounts.length > 0)) {
		throw new AffinityConflict('The local runtime cannot mount host or managed storage.');
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

export class RuntimeService {
	private readonly readiness: ReadinessProbe;
	private networkEnsured = false;

	constructor(
		private readonly docker: Docker,
		private readonly ledger: RuntimeLedger,
		private readonly artifactStore: ArtifactStore,
		private readonly config: RuntimeServiceConfig,
		private readonly clock: () => number = Date.now,
		readinessProbe?: ReadinessProbe,
	) {
		this.readiness = readinessProbe ?? new TcpReadinessProbe();
	}

	private now(): number {
		const now = Math.floor(this.clock() / 1000);
		if (now <= 0) throw new RuntimeUnavailable('the driver clock is invalid');
		return now;
	}

	private async ensureNetwork(): Promise<void> {
		if (this.networkEnsured) return;
		try {
			await this.docker.createNetwork({
				Name: this.config.privateNetwork,
				Driver: 'bridge',
				Internal: true,
				CheckDuplicate: true,
			});
		} catch (err: any) {
			if (err?.statusCode !== 409) throw new RuntimeUnavailable(`failed to ensure the local-runtime network: ${err?.message ?? String(err)}`);
		}
		this.networkEnsured = true;
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

	/** Creates (if absent), starts, verifies, and TCP-probes the deterministic policy container. Returns its container id. */
	private async reconcileContainer(policy: ContainerPolicy, artifact: StagedArtifactRecord): Promise<string> {
		await this.ensureNetwork();
		let container = await this.inspectByName(policy.runtimeId);
		if (!container) {
			const created = await this.docker.createContainer(policy.createSpec);
			await created.start();
			container = await this.inspectByName(policy.runtimeId);
			if (!container) throw new RuntimeUnavailable('Docker did not persist the deterministic container.');
		}
		assertContainerMatchesPolicy(container, policy, artifact);
		if (!container.State?.Running) {
			await this.docker.getContainer(container.Id).start().catch((err: any) => {
				if (err?.statusCode !== 304) throw new RuntimeUnavailable(`failed to start the local runtime container: ${err?.message ?? String(err)}`);
			});
			container = await this.inspectByName(policy.runtimeId);
			if (!container) throw new RuntimeUnavailable('the local runtime container disappeared after start');
		}
		assertContainerMatchesPolicy(container, policy, artifact);
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
		const policy = buildPolicy(request, artifact, this.config, null);
		const requestJson = JSON.stringify(sortedCanonical(request));
		const requestHash = canonicalHash(request);

		let record: RuntimeRecord = this.ledger.claim({
			generationId: request.generation_id,
			installationId: request.installation_id,
			generationNumber: request.generation_number,
			requestHash,
			requestJson,
			runtimeId: policy.runtimeId,
			artifactDigest: artifact.digest,
			imageManifestDigest: artifact.manifestDigest,
			imageConfigDigest: artifact.configDigest,
			containerSpecHash: policy.containerSpecHash,
			now: this.now(),
		});

		// EXACT_READY_REPLAY: once READY evidence is durable, ensureReady/status
		// always replay the exact stored document — including after activation
		// (the ledger only ever ADDS activation fields to the record; it never
		// clears `readyResponseJson`, so this covers every later replay too).
		if (record.readyResponseJson) {
			return validateReady(JSON.parse(record.readyResponseJson));
		}

		const containerId = await this.reconcileContainer(policy, artifact);
		record = this.ledger.recordContainer(request.generation_id, requestHash, containerId, this.now());

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
		const marked = this.ledger.markReady(request.generation_id, requestHash, responseJson, evidenceJson, readyAt);
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

	async activate(rawRequest: unknown): Promise<ActiveEvidence> {
		const activation = validateActivate(rawRequest);
		return this.ledger.withRuntimeLock(activation.runtime_id, async () => {
			const record = this.ledger.getByRuntimeId(activation.runtime_id);
			if (!record) throw new RuntimeNotFound();
			const request = validateEnsureReady(JSON.parse(record.requestJson));
			const artifact = this.resolveStagedArtifact(request.artifact.digest);
			const preactivationPolicy = buildPolicy(request, artifact, this.config, null);
			this.assertActivationAffinity(activation, request, preactivationPolicy, artifact);

			// READY must be durable and the preactivation container reconciled
			// before the irreversible activation intent is claimed.
			await this.ensureReadyLocked(request);

			const activePolicy = buildPolicy(request, artifact, this.config, activation);
			const claimed = this.ledger.claimActivation({
				runtimeId: activation.runtime_id,
				requestHash: canonicalHash(request),
				activationRequestHash: canonicalHash(activation),
				activationRequestJson: JSON.stringify(sortedCanonical(activation)),
				activeContainerSpecHash: activePolicy.containerSpecHash,
				now: this.now(),
			});

			if (claimed.state === 'ACTIVE' && claimed.activeResponseJson) {
				return validateActive(JSON.parse(claimed.activeResponseJson));
			}

			// The preactivation and active-phase containers share one Docker name
			// (`runtimeId` does not depend on activation), so a crash-retry of an
			// ACTIVATING claim can find the container already swapped to the
			// active-phase policy. Only stop+remove the preactivation container
			// when it is still actually in the preactivation phase; otherwise this
			// replay just reconciles (verifies + ensures running) the existing one.
			const current = await this.inspectByName(activePolicy.runtimeId);
			const alreadyActivePhase = current !== null && isPolicyMatch(current, activePolicy, artifact);
			if (!alreadyActivePhase) {
				await this.removeContainerVerified(preactivationPolicy.runtimeId, preactivationPolicy, artifact);
			}
			const containerId = await this.reconcileContainer(activePolicy, artifact);
			this.ledger.recordContainer(request.generation_id, canonicalHash(request), containerId, this.now());

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
				const container = await this.inspectByName(request.runtime_id);
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
				this.ledger.deleteByRuntimeId(request.runtime_id);
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
}
