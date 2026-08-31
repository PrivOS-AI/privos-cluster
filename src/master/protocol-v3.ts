import type { JsonWebKey } from 'node:crypto';
import { z } from 'zod';

import {
	assertArtifactTime,
	canonicalJson,
	parseJws,
	sha256Base64Url,
	verifyEs256Jws,
} from '../security/artifacts.js';
import { isAllowedReservedEnvName } from '../schemas/app-schemas.js';

/**
 * Internal Hub-to-Cluster protocol only.
 *
 * These compact JWS artifacts use direct claims to preserve the established
 * Cluster boundary. They do not parse or fall back to the canonical outer
 * Portal-to-Hub envelope. Hub validates that envelope, maps it to these exact
 * generation/resource claims, and later verifies Cluster evidence before Hub
 * signs its own Portal-facing acknowledgement.
 */

export const MCP_PROTOCOL_V3 = 3 as const;

const Identifier = z.string().min(1).max(160);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ArtifactHash = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Nonce = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const SafeReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,95}$/);
/**
 * Operator-declarable environment name; the PRIVOS_ namespace is platform-only,
 * except the Hub-issued agent-bot credential pair, which the Hub delivers
 * inside `envVars` on its signed reconfigure command.
 */
const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).refine(
	(value) => !value.startsWith('PRIVOS_') || isAllowedReservedEnvName(value),
	{ message: 'PRIVOS_ environment names are reserved for the platform' },
);
/**
 * Configuration generation within one runtime generation. Orthogonal to
 * authorizationEpoch: applying configuration can never widen permissions.
 */
const ConfigEpoch = z.number().int().positive();
const TimedArtifactShape = {
	protocolVersion: z.literal(MCP_PROTOCOL_V3),
	iss: Identifier,
	jti: z.string().uuid(),
	nonce: Nonce,
	iat: z.number().int(),
	exp: z.number().int(),
};

export const McpProtocolV3ErrorCodeSchema = z.enum([
	'PROTOCOL_VERSION_UNSUPPORTED',
	'PROTOCOL_ENVELOPE_INVALID',
	'ACQUISITION_ROOM_AFFINITY_FORBIDDEN',
	'ARTIFACT_SIGNATURE_INVALID',
	'ARTIFACT_TIME_INVALID',
	'ARTIFACT_REPLAYED',
	'GENERATION_AFFINITY_MISMATCH',
	'GENERATION_IDENTITY_REUSED',
	'RESOURCE_MANIFEST_HASH_MISMATCH',
	'RUNTIME_RESOURCE_INVENTORY_HASH_MISMATCH',
	'RESOURCE_INVENTORY_COUNT_MISMATCH',
	'ROOM_BINDING_REQUIRED',
	'ROOM_BINDING_MISMATCH',
	'INVALID_LIFECYCLE_TRANSITION',
	'UNINSTALL_ALREADY_IN_PROGRESS',
	'CLEANUP_REQUIRED',
	'MIGRATION_REVIEW_REQUIRED',
	'CONFIG_EPOCH_INVALID',
	'CONFIG_ENVIRONMENT_RESERVED',
	'RUNTIME_NOT_RECONFIGURABLE',
	'RUNTIME_NOT_UPGRADABLE',
	'UPGRADE_EPOCH_INVALID',
	'UPGRADE_PREVIOUS_DIGEST_MISMATCH',
]);

export type McpProtocolV3ErrorCode = z.infer<typeof McpProtocolV3ErrorCodeSchema>;

export class McpProtocolV3Error extends Error {
	constructor(
		readonly code: McpProtocolV3ErrorCode,
		message: string = code,
	) {
		super(message);
		this.name = 'McpProtocolV3Error';
	}
}

export const AcquisitionAffinityV3Schema = z.object({
	protocolVersion: z.literal(MCP_PROTOCOL_V3),
	type: z.literal('mcp-acquisition-affinity'),
	listingId: Identifier,
	versionId: Identifier,
	offerId: Identifier,
	workspaceId: Identifier,
	deploymentId: Identifier,
	executionMode: z.enum(['SELF_HOSTED_LOCAL', 'PRIVOS_MANAGED_RUNTIME', 'PUBLISHER_HOSTED']),
	availabilityTier: z.enum(['single', 'ha']),
	commercial: z.object({
		pricingModel: z.enum(['FREE', 'ONE_TIME', 'SUBSCRIPTION']),
		amountCents: z.number().int().nonnegative(),
		currency: z.string().regex(/^[A-Z]{3}$/),
	}).strict(),
	manifestDigest: Digest,
	permissionCeilingHash: ArtifactHash,
	dataPolicyHash: ArtifactHash,
}).strict();

export type AcquisitionAffinityV3 = z.infer<typeof AcquisitionAffinityV3Schema>;

function containsRoomAffinity(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsRoomAffinity);
	if (!value || typeof value !== 'object') return false;
	return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
		const normalized = key.replace(/[_-]/g, '').toLowerCase();
		return normalized === 'roomid' || normalized === 'targetroomid' ||
			normalized === 'roomtarget' || normalized === 'roomaffinity' ||
			(normalized === 'target' && child !== null && typeof child === 'object' &&
				(child as Record<string, unknown>).type === 'room') || containsRoomAffinity(child);
	});
}

export function parseRoomlessAcquisitionAffinityV3(value: unknown): AcquisitionAffinityV3 {
	if (containsRoomAffinity(value)) {
		throw new McpProtocolV3Error('ACQUISITION_ROOM_AFFINITY_FORBIDDEN');
	}
	try {
		return AcquisitionAffinityV3Schema.parse(value);
	} catch (error) {
		if (error instanceof McpProtocolV3Error) throw error;
		throw new McpProtocolV3Error('PROTOCOL_ENVELOPE_INVALID');
	}
}

export function acquisitionAffinityHashV3(value: AcquisitionAffinityV3): string {
	return sha256Base64Url(canonicalJson(AcquisitionAffinityV3Schema.parse(value)));
}

const DeploymentDescriptorV3Schema = z.object({
	clusterAppId: Identifier,
	listingId: Identifier,
	versionId: Identifier,
	versionDigest: Digest,
	image: z.string().min(1).max(2048),
	imageDigest: Digest,
	manifestDigest: Digest,
	resourceManifestHash: ArtifactHash,
	port: z.number().int().min(1).max(65535),
	resources: z.object({
		memoryMb: z.number().int().min(64).max(16384),
		cpus: z.number().min(0.1).max(16),
		tmpSizeMb: z.number().int().min(16).max(4096),
	}).strict(),
	envVars: z.record(z.string(), z.string()),
	// Which of envVars are operator secrets. Optional so a Hub that predates the
	// contract still installs; absent means "nothing is secret", which is the
	// pre-existing behaviour (the Hub only ever sent {}).
	secretEnvKeys: z.array(EnvName).max(32).optional(),
	volumes: z.array(z.object({
		name: z.string().regex(/^[a-z0-9-]{1,32}$/),
		mountPath: z.string().startsWith('/').max(200),
		sizeMb: z.number().int().positive().optional(),
	}).strict()).max(10),
	availabilityTier: z.enum(['single', 'ha']),
	stateless: z.boolean(),
	releaseAttestationJws: z.string().min(32),
	subdomain: z.string().nullable(),
	domain: z.string().nullable(),
}).strict();

export const McpDeploymentGrantPayloadV3Schema = z.object({
	...TimedArtifactShape,
	type: z.literal('mcp-deployment-grant'),
	aud: z.literal('privos-apps-master'),
	clusterId: Identifier,
	workspaceId: Identifier,
	deploymentId: Identifier,
	generationId: Identifier,
	generationNumber: z.number().int().positive(),
	runtimeInstallationId: Identifier,
	mcpAppId: Identifier,
	acquisitionAffinityHash: ArtifactHash,
	approvalReceiptHash: ArtifactHash,
	approvedPermissionCeilingHash: ArtifactHash,
	authorizationEpoch: z.number().int().positive(),
	// Configuration generation for the operator-supplied environment. Optional so
	// a Hub that predates the contract still installs; absent means epoch 1.
	configEpoch: ConfigEpoch.optional(),
	hubOrigin: z.string().url().refine((value) => new URL(value).protocol === 'https:'),
	deployment: DeploymentDescriptorV3Schema,
}).strict();

export type McpDeploymentGrantPayloadV3 = z.infer<typeof McpDeploymentGrantPayloadV3Schema>;

/**
 * Configuration-only redeploy of an existing generation.
 *
 * Deliberately NOT a re-issued deployment grant: a grant is bound to a fresh
 * generation identity (reuse raises GENERATION_IDENTITY_REUSED), and nothing
 * about the image, permissions, or resources may move here. The command
 * restates the generation only so the Cluster can bind it to what it holds.
 */
export const ClusterReconfigureCommandPayloadV3Schema = z.object({
	...TimedArtifactShape,
	type: z.literal('cluster-reconfigure-command'),
	aud: z.literal('privos-apps-master'),
	action: z.literal('RECONFIGURE_RUNTIME'),
	operationId: z.string().uuid(),
	clusterId: Identifier,
	workspaceId: Identifier,
	deploymentId: Identifier,
	generationId: Identifier,
	generationNumber: z.number().int().positive(),
	runtimeInstallationId: Identifier,
	clusterAppId: Identifier,
	mcpAppId: Identifier,
	manifestDigest: Digest,
	resourceManifestHash: ArtifactHash,
	runtimeResourceInventoryHash: ArtifactHash,
	authorizationEpoch: z.number().int().positive(),
	configEpoch: ConfigEpoch,
	envVars: z.record(EnvName, z.string().max(4096)).refine(
		(value) => Object.keys(value).length <= 32,
		{ message: 'at most 32 environment values' },
	),
	secretKeys: z.array(EnvName).max(32),
}).strict().superRefine((value, ctx) => {
	for (const key of value.secretKeys) {
		if (!(key in value.envVars)) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['secretKeys'], message: 'secret names must exist in envVars' });
		}
	}
});

export type ClusterReconfigureCommandPayloadV3 = z.infer<typeof ClusterReconfigureCommandPayloadV3Schema>;

/**
 * Cluster evidence that a configuration epoch is the one now running. Key NAMES
 * only — this artifact is persisted and logged on the Hub.
 */
export const ClusterReconfigureAcknowledgementPayloadV3Schema = z.object({
	...TimedArtifactShape,
	type: z.literal('cluster-reconfigure-acknowledgement'),
	aud: z.literal('privos-hub-api'),
	operationId: z.string().uuid(),
	clusterId: Identifier,
	workspaceId: Identifier,
	deploymentId: Identifier,
	generationId: Identifier,
	generationNumber: z.number().int().positive(),
	runtimeInstallationId: Identifier,
	clusterAppId: Identifier,
	manifestDigest: Digest,
	resourceManifestHash: ArtifactHash,
	runtimeResourceInventoryHash: ArtifactHash,
	configEpoch: ConfigEpoch,
	state: z.enum(['APPLIED', 'FAILED']),
	appliedKeys: z.array(EnvName).max(32),
	appliedAt: z.string().datetime().nullable(),
	errorCode: SafeReasonCode.nullable(),
}).strict().superRefine((value, ctx) => {
	if (value.state === 'APPLIED' && value.appliedAt === null) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['appliedAt'], message: 'an applied epoch must carry its timestamp' });
	}
	const sorted = [...value.appliedKeys].sort();
	if (value.appliedKeys.some((key, index) => key !== sorted[index])) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['appliedKeys'], message: 'applied keys must be sorted' });
	}
});

export type ClusterReconfigureAcknowledgementPayloadV3 = z.infer<
	typeof ClusterReconfigureAcknowledgementPayloadV3Schema
>;

/**
 * A revision swap of the image already running under an established
 * generation (D1: the generation, its number, and everything it owns are
 * untouched — only the image moves).
 *
 * Unlike reconfigure, `targetManifestDigest`/`targetImageDigest` are NEW: the
 * Cluster's manifest-label check runs against the new image before this
 * command touches the old runtime at all, mirroring the same byte-exact check
 * that gates installs. `previousManifestDigest`/`previousImageDigest` name the
 * revert target so a failed upgrade has somewhere named to go back to (D4)
 * rather than a recomputed guess. `revision` is the generation-scoped image
 * counter (bumped by every swap, including a rollback, so a retried upgrade
 * is never mistaken for one already applied); `upgradeEpoch` is spent
 * one-for-one with `revision` and exists to answer a redelivered command that
 * reuses an already-applied revision number with `epoch_reused` rather than
 * silently repeating — or silently skipping — the swap.
 */
export const ClusterUpgradeCommandPayloadV3Schema = z.object({
	...TimedArtifactShape,
	type: z.literal('cluster-upgrade-command'),
	aud: z.literal('privos-apps-master'),
	action: z.literal('UPGRADE_RUNTIME'),
	operationId: z.string().uuid(),
	clusterId: Identifier,
	workspaceId: Identifier,
	deploymentId: Identifier,
	generationId: Identifier,
	generationNumber: z.number().int().positive(),
	revision: z.number().int().positive(),
	runtimeInstallationId: Identifier,
	clusterAppId: Identifier,
	mcpAppId: Identifier,
	targetManifestDigest: Digest,
	targetImageDigest: Digest,
	previousManifestDigest: Digest,
	previousImageDigest: Digest,
	resourceManifestHash: ArtifactHash,
	runtimeResourceInventoryHash: ArtifactHash,
	authorizationEpoch: z.number().int().positive(),
	/**
	 * The epoch the runtime must attest with once this swap lands.
	 *
	 * `authorizationEpoch` above is the affinity value — what the Hub believes
	 * the generation carries RIGHT NOW, checked against the stored app row.
	 * The Hub rotates the credential epoch at its own cutover, so the redeployed
	 * container has to be labelled with the value that comes AFTER, not the one
	 * being retired. Carrying only the current epoch left the Hub on N+1 and
	 * every upgraded runtime on N, and pairing then failed permanently with
	 * `installation_binding_mismatch`.
	 */
	resultingAuthorizationEpoch: z.number().int().positive(),
	upgradeEpoch: z.number().int().positive(),
}).strict().superRefine((value, ctx) => {
	// The rotation is exactly one step, and it must move. Anything else is a
	// malformed or forged command: equal would silently keep the retired epoch
	// alive, and a jump would strand the runtime behind the Hub.
	if (value.resultingAuthorizationEpoch !== value.authorizationEpoch + 1) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['resultingAuthorizationEpoch'],
			message: 'resultingAuthorizationEpoch must be authorizationEpoch + 1',
		});
	}
	// v1 spends exactly one upgradeEpoch per revision — see the class comment.
	// A mismatch can only be a malformed or forged command, never a legitimate
	// retry, so it is refused at the schema boundary rather than reaching the
	// business-layer epoch guard.
	if (value.upgradeEpoch !== value.revision) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['upgradeEpoch'],
			message: 'upgradeEpoch must equal revision',
		});
	}
	if (
		value.targetManifestDigest === value.previousManifestDigest ||
		value.targetImageDigest === value.previousImageDigest
	) {
		// Either alone already means nothing legitimate moved: the two digests
		// are 1:1 with a single published image, so a command whose manifest
		// digest matches the previous one but whose image digest doesn't (or
		// vice versa) is not a smaller version of a real upgrade — it is
		// malformed or forged, and refusing on either field alone is stricter,
		// not looser, than requiring both to match.
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ['targetManifestDigest'],
			message: 'an upgrade must name a different image than the one it replaces',
		});
	}
});

export type ClusterUpgradeCommandPayloadV3 = z.infer<typeof ClusterUpgradeCommandPayloadV3Schema>;

/**
 * Cluster evidence of what is now actually serving. `swapStrategy` is reported
 * here — never recomputed elsewhere — because the Cluster is the only layer
 * that knows whether the container carries persistent volumes (D1a); the
 * Portal's downtime disclosure to the workspace owner is driven off this
 * field. `state` is terminal:
 *
 * - `UPGRADED` — new image running.
 * - `ROLLED_BACK` — a swap was attempted, it failed, and the previous image
 *   was confirmed restored.
 * - `FAILED` — a swap was attempted, it failed, and the restore could not be
 *   confirmed either. Rare, and the only state an operator needs to look at.
 * - `REFUSED` — **no container was ever touched.** The command was refused
 *   before the swap started (unknown/stale generation, a stale epoch, the app
 *   not RUNNING, ...). This is NOT the same as `FAILED`: the installation is
 *   exactly as it was, and the Hub must treat this as a normal, retryable
 *   refusal — NOT drive the installation into a stuck cleanup/terminal state.
 *   Collapsing this into `FAILED` is the specific mistake this variant exists
 *   to prevent: a Hub that cannot tell "nothing happened" from "something
 *   broke" has no correct action to take for the former.
 */
export const ClusterUpgradeAcknowledgementPayloadV3Schema = z.object({
	...TimedArtifactShape,
	type: z.literal('cluster-upgrade-acknowledgement'),
	aud: z.literal('privos-hub-api'),
	operationId: z.string().uuid(),
	clusterId: Identifier,
	workspaceId: Identifier,
	deploymentId: Identifier,
	generationId: Identifier,
	generationNumber: z.number().int().positive(),
	revision: z.number().int().positive(),
	runtimeInstallationId: Identifier,
	clusterAppId: Identifier,
	runningManifestDigest: Digest,
	runningImageDigest: Digest,
	resourceManifestHash: ArtifactHash,
	runtimeResourceInventoryHash: ArtifactHash,
	upgradeEpoch: z.number().int().positive(),
	swapStrategy: z.enum(['ROLLING', 'STOP_THEN_CREATE']),
	state: z.enum(['UPGRADED', 'ROLLED_BACK', 'FAILED', 'REFUSED']),
	upgradedAt: z.string().datetime().nullable(),
	errorCode: SafeReasonCode.nullable(),
}).strict().superRefine((value, ctx) => {
	if (value.state === 'UPGRADED' && value.upgradedAt === null) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['upgradedAt'], message: 'an upgraded revision must carry its timestamp' });
	}
	if (value.state !== 'UPGRADED' && value.upgradedAt !== null) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['upgradedAt'], message: 'only an upgraded revision carries a timestamp' });
	}
});

export type ClusterUpgradeAcknowledgementPayloadV3 = z.infer<
	typeof ClusterUpgradeAcknowledgementPayloadV3Schema
>;

/**
 * Who the Hub says initiated this dispatch, when the app declared it can read
 * one. Opaque to the master: it is forwarded inside the signed assertion for
 * the app to display or attribute with, and is deliberately excluded from
 * affinity, routing, replay and logging. Nothing here may become an
 * authorization input — the room binding remains the only thing that decides
 * what a dispatch is allowed to reach.
 *
 * Absent on every assertion the fleet signs today, and absent forever for an
 * agent or roomless dispatch, so absence must stay valid.
 */
const DispatchActor = z.object({
	subject: z.string().min(1),
	username: z.string().optional(),
	roomId: z.string().optional(),
}).strict();

const DispatchCommonShape = {
	...TimedArtifactShape,
	actor: DispatchActor.optional(),
	type: z.literal('hub-dispatch-assertion'),
	aud: z.literal('privos-mcp-app'),
	clusterId: Identifier,
	workspaceId: Identifier,
	deploymentId: Identifier,
	generationId: Identifier,
	generationNumber: z.number().int().positive(),
	runtimeInstallationId: Identifier,
	mcpAppId: Identifier,
	clusterAppId: Identifier,
	htm: z.literal('POST'),
	htu: z.literal('/mcp'),
	bodyDigest: ArtifactHash,
	manifestDigest: Digest,
	resourceManifestHash: ArtifactHash,
	runtimeResourceInventoryHash: ArtifactHash,
	runtimeApprovalReceiptHash: ArtifactHash,
	runtimeGrantEpoch: z.number().int().positive(),
};

const WorkspaceDispatchAssertionV3Schema = z.object({
	...DispatchCommonShape,
	authorizationContext: z.literal('workspace'),
}).strict();

const RoomDispatchAssertionV3Schema = z.object({
	...DispatchCommonShape,
	authorizationContext: z.literal('room'),
	roomId: Identifier,
	authorizationBindingId: Identifier,
	bindingReceiptHash: ArtifactHash,
	bindingEpoch: z.number().int().positive(),
}).strict();

export const McpDispatchAssertionPayloadV3Schema = z.discriminatedUnion('authorizationContext', [
	WorkspaceDispatchAssertionV3Schema,
	RoomDispatchAssertionV3Schema,
]);

export type McpDispatchAssertionPayloadV3 = z.infer<typeof McpDispatchAssertionPayloadV3Schema>;

export type McpDispatchActorV3 = z.infer<typeof DispatchActor>;

export function parseDispatchAssertionPayloadV3(value: unknown): McpDispatchAssertionPayloadV3 {
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (
			record.authorizationContext === 'room' &&
			(!record.roomId || !record.authorizationBindingId || !record.bindingReceiptHash || !record.bindingEpoch)
		) throw new McpProtocolV3Error('ROOM_BINDING_REQUIRED');
	}
	try {
		return McpDispatchAssertionPayloadV3Schema.parse(value);
	} catch {
		throw new McpProtocolV3Error('PROTOCOL_ENVELOPE_INVALID');
	}
}

export const ClusterLifecycleCommandPayloadV3Schema = z.object({
	...TimedArtifactShape,
	type: z.literal('cluster-lifecycle-command'),
	aud: z.literal('privos-apps-master'),
	action: z.literal('UNINSTALL_RUNTIME'),
	operationId: z.string().uuid(),
	clusterId: Identifier,
	workspaceId: Identifier,
	deploymentId: Identifier,
	generationId: Identifier,
	generationNumber: z.number().int().positive(),
	runtimeInstallationId: Identifier,
	clusterAppId: Identifier,
	manifestDigest: Digest,
	resourceManifestHash: ArtifactHash,
	runtimeResourceInventoryHash: ArtifactHash,
	reasonCode: SafeReasonCode,
	expectedResourceCount: z.number().int().positive(),
}).strict();

export type ClusterLifecycleCommandPayloadV3 = z.infer<typeof ClusterLifecycleCommandPayloadV3Schema>;

export const RuntimeResourceKindV3Schema = z.enum([
	'REPLICA',
	'CONTAINER',
	'INGRESS',
	'BROKER_BINDING',
	'BROKER_SOCKET',
	'SERVICE_DISCOVERY',
	'VOLUME',
]);

export type RuntimeResourceKindV3 = z.infer<typeof RuntimeResourceKindV3Schema>;

export const RuntimeResourceOwnershipScopeV3Schema = z.enum([
	'ROOM_BINDING',
	'INSTALLATION_GENERATION',
	'DEPLOYMENT_SHARED',
	'PLATFORM_SHARED',
]);

export const RuntimeResourceDescriptorV3Schema = z.object({
	kind: RuntimeResourceKindV3Schema,
	resourceId: Identifier,
	ownershipScope: RuntimeResourceOwnershipScopeV3Schema,
	nodeId: Identifier.nullable(),
	replicaId: z.string().uuid().nullable(),
	attributes: z.record(z.string(), z.string()),
}).strict();

export type RuntimeResourceDescriptorV3 = z.infer<typeof RuntimeResourceDescriptorV3Schema>;

export const ClusterRuntimeInventoryAttestationPayloadV3Schema = z.object({
	...TimedArtifactShape,
	type: z.literal('cluster-runtime-inventory-attestation'),
	aud: z.literal('privos-hub-api'),
	deploymentGrantJti: z.string().uuid(),
	inventoryId: Identifier,
	clusterId: Identifier,
	workspaceId: Identifier,
	deploymentId: Identifier,
	generationId: Identifier,
	generationNumber: z.number().int().positive(),
	runtimeInstallationId: Identifier,
	clusterAppId: Identifier,
	manifestDigest: Digest,
	resourceManifestHash: ArtifactHash,
	runtimeResourceInventoryHash: ArtifactHash,
	expectedResourceCount: z.number().int().positive(),
	persistedAt: z.string().datetime(),
}).strict();

export type ClusterRuntimeInventoryAttestationPayloadV3 = z.infer<
	typeof ClusterRuntimeInventoryAttestationPayloadV3Schema
>;

export const ResourceCleanupResultV3Schema = z.object({
	kind: RuntimeResourceKindV3Schema,
	resourceId: Identifier,
	status: z.enum(['ABSENT', 'REMOVED', 'FAILED', 'UNKNOWN']),
	reasonCode: SafeReasonCode.nullable(),
	verifiedAt: z.string().datetime().nullable(),
}).strict();

export type ResourceCleanupResultV3 = z.infer<typeof ResourceCleanupResultV3Schema>;

export const ClusterLifecycleStateV3Schema = z.enum([
	'REQUESTED',
	'COMMAND_VERIFIED',
	'ACCESS_REVOKED',
	'RUNTIME_REMOVING',
	'VERIFYING',
	'CLEANUP_REQUIRED',
	'COMPLETED',
]);

export type ClusterLifecycleStateV3 = z.infer<typeof ClusterLifecycleStateV3Schema>;

export const ClusterLifecycleStepV3Schema = z.enum([
	'COMMAND_ACCEPTED',
	'ACCESS_REVOKED',
	'BROKERS_REMOVED',
	'CONTAINERS_REMOVED',
	'INGRESS_REMOVED',
	'VOLUMES_REMOVED',
	'ABSENCE_VERIFIED',
	'ACKNOWLEDGEMENT_SIGNED',
]);

export type ClusterLifecycleStepV3 = z.infer<typeof ClusterLifecycleStepV3Schema>;

export const ClusterLifecycleCheckpointV3Schema = z.object({
	protocolVersion: z.literal(MCP_PROTOCOL_V3),
	type: z.literal('cluster-lifecycle-checkpoint'),
	operationId: z.string().uuid(),
	clusterId: Identifier,
	workspaceId: Identifier,
	deploymentId: Identifier,
	generationId: Identifier,
	generationNumber: z.number().int().positive(),
	runtimeInstallationId: Identifier,
	resourceManifestHash: ArtifactHash,
	runtimeResourceInventoryHash: ArtifactHash,
	state: ClusterLifecycleStateV3Schema,
	step: ClusterLifecycleStepV3Schema,
	attempt: z.number().int().positive(),
	startedAt: z.string().datetime(),
	completedAt: z.string().datetime().nullable(),
	results: z.array(ResourceCleanupResultV3Schema),
	errorCode: SafeReasonCode.nullable(),
}).strict();

export type ClusterLifecycleCheckpointV3 = z.infer<typeof ClusterLifecycleCheckpointV3Schema>;

export const NodeCleanupResultPayloadV3Schema = z.object({
	...TimedArtifactShape,
	type: z.literal('cluster-node-cleanup-result'),
	aud: z.literal('privos-apps-master'),
	operationId: z.string().uuid(),
	clusterId: Identifier,
	nodeId: Identifier,
	workspaceId: Identifier,
	deploymentId: Identifier,
	generationId: Identifier,
	generationNumber: z.number().int().positive(),
	runtimeInstallationId: Identifier,
	resourceManifestHash: ArtifactHash,
	runtimeResourceInventoryHash: ArtifactHash,
	complete: z.boolean(),
	results: z.array(ResourceCleanupResultV3Schema).min(1),
}).strict().superRefine((value, ctx) => {
	if (
		value.complete &&
		value.results.some((result) =>
			!['ABSENT', 'REMOVED'].includes(result.status) || result.verifiedAt === null)
	) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['results'], message: 'complete evidence must prove every resource absent' });
	const identities = new Set(value.results.map((result) => `${result.kind}\0${result.resourceId}`));
	if (identities.size !== value.results.length) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['results'], message: 'cleanup result identities must be unique' });
	}
});

export type NodeCleanupResultPayloadV3 = z.infer<typeof NodeCleanupResultPayloadV3Schema>;

export const ClusterFinalAcknowledgementPayloadV3Schema = z.object({
	...TimedArtifactShape,
	type: z.literal('cluster-final-cleanup-acknowledgement'),
	aud: z.literal('privos-hub-api'),
	operationId: z.string().uuid(),
	clusterId: Identifier,
	workspaceId: Identifier,
	deploymentId: Identifier,
	generationId: Identifier,
	generationNumber: z.number().int().positive(),
	runtimeInstallationId: Identifier,
	clusterAppId: Identifier,
	manifestDigest: Digest,
	resourceManifestHash: ArtifactHash,
	runtimeResourceInventoryHash: ArtifactHash,
	state: z.enum(['COMPLETED', 'CLEANUP_REQUIRED']),
	expectedResourceCount: z.number().int().nonnegative(),
	nodeResultHashes: z.array(ArtifactHash),
	results: z.array(ResourceCleanupResultV3Schema),
	completedAt: z.string().datetime().nullable(),
}).strict().superRefine((value, ctx) => {
	const identities = new Set(value.results.map((result) => `${result.kind}\0${result.resourceId}`));
	if (identities.size !== value.results.length) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['results'], message: 'cleanup result identities must be unique' });
	}
	if (
		value.state === 'COMPLETED' &&
		(value.completedAt === null ||
			value.results.length !== value.expectedResourceCount ||
			value.results.some((result) =>
				!['ABSENT', 'REMOVED'].includes(result.status) || result.verifiedAt === null))
	) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['state'], message: 'completed acknowledgement must prove zero residue' });
});

export type ClusterFinalAcknowledgementPayloadV3 = z.infer<typeof ClusterFinalAcknowledgementPayloadV3Schema>;

export const RuntimeGenerationStateV3Schema = z.enum([
	'AUTHORIZED',
	'PROVISIONING',
	'ACTIVE',
	'REVOKING',
	'CLEANUP_REQUIRED',
	'UNINSTALLED',
]);

export type RuntimeGenerationStateV3 = z.infer<typeof RuntimeGenerationStateV3Schema>;

const generationTransitions: Record<RuntimeGenerationStateV3, ReadonlySet<RuntimeGenerationStateV3>> = {
	AUTHORIZED: new Set(['PROVISIONING', 'REVOKING']),
	PROVISIONING: new Set(['ACTIVE', 'REVOKING', 'CLEANUP_REQUIRED']),
	ACTIVE: new Set(['REVOKING']),
	REVOKING: new Set(['CLEANUP_REQUIRED', 'UNINSTALLED']),
	CLEANUP_REQUIRED: new Set(['REVOKING', 'UNINSTALLED']),
	UNINSTALLED: new Set(),
};

const lifecycleTransitions: Record<ClusterLifecycleStateV3, ReadonlySet<ClusterLifecycleStateV3>> = {
	REQUESTED: new Set(['COMMAND_VERIFIED']),
	COMMAND_VERIFIED: new Set(['ACCESS_REVOKED', 'CLEANUP_REQUIRED']),
	ACCESS_REVOKED: new Set(['RUNTIME_REMOVING', 'CLEANUP_REQUIRED']),
	RUNTIME_REMOVING: new Set(['VERIFYING', 'CLEANUP_REQUIRED']),
	VERIFYING: new Set(['COMPLETED', 'CLEANUP_REQUIRED']),
	CLEANUP_REQUIRED: new Set(['ACCESS_REVOKED', 'RUNTIME_REMOVING', 'VERIFYING']),
	COMPLETED: new Set(),
};

function assertTransition<T extends string>(
	from: T,
	to: T,
	transitions: Record<T, ReadonlySet<T>>,
): void {
	if (from === to) return;
	if (!transitions[from].has(to)) {
		throw new McpProtocolV3Error('INVALID_LIFECYCLE_TRANSITION', `${from} -> ${to}`);
	}
}

export function assertRuntimeGenerationTransitionV3(
	from: RuntimeGenerationStateV3,
	to: RuntimeGenerationStateV3,
): void {
	assertTransition(from, to, generationTransitions);
}

export function assertClusterLifecycleTransitionV3(
	from: ClusterLifecycleStateV3,
	to: ClusterLifecycleStateV3,
): void {
	assertTransition(from, to, lifecycleTransitions);
}

type SignedV3Input<T> = {
	compact: string;
	publicJwk: JsonWebKey;
	kid: string;
	typ: string;
	schema: z.ZodType<T>;
	maximumLifetimeSeconds: number;
};

function verifySignedV3<T>(input: SignedV3Input<T>): T {
	try {
		const unverified = parseJws(input.compact);
		if (unverified.header.privos_protocol !== MCP_PROTOCOL_V3) {
			throw new McpProtocolV3Error('PROTOCOL_VERSION_UNSUPPORTED');
		}
		const headerMembers = Object.keys(unverified.header).sort();
		if (
			headerMembers.length !== 4 ||
			!['alg', 'kid', 'privos_protocol', 'typ'].every((member) => headerMembers.includes(member))
		) throw new McpProtocolV3Error('PROTOCOL_ENVELOPE_INVALID');
		const parsed = verifyEs256Jws({
			compact: input.compact,
			publicJwk: input.publicJwk,
			kid: input.kid,
			typ: input.typ,
			protocolVersion: MCP_PROTOCOL_V3,
		});
		const payload = input.schema.parse(parsed.payload);
		assertArtifactTime(payload as Record<string, unknown>, input.maximumLifetimeSeconds);
		return payload;
	} catch (error) {
		if (error instanceof McpProtocolV3Error) throw error;
		if (error instanceof Error && error.message === 'artifact_time_invalid') {
			throw new McpProtocolV3Error('ARTIFACT_TIME_INVALID');
		}
		if (error instanceof z.ZodError) throw new McpProtocolV3Error('PROTOCOL_ENVELOPE_INVALID');
		throw new McpProtocolV3Error('ARTIFACT_SIGNATURE_INVALID');
	}
}

export type ProvisioningAffinityV3 = {
	clusterId: string;
	workspaceId: string;
	deploymentId: string;
	generationId: string;
	generationNumber: number;
	runtimeInstallationId: string;
	resourceManifestHash: string;
	issuer: string;
};

export type GenerationAffinityV3 = ProvisioningAffinityV3 & {
	runtimeResourceInventoryHash: string;
};

export type DeploymentGrantAffinityV3 = ProvisioningAffinityV3 & {
	previousGeneration?: {
		generationId: string;
		generationNumber: number;
		runtimeInstallationId: string;
	};
};

export function assertProvisioningAffinityV3(
	payload: Omit<ProvisioningAffinityV3, 'issuer'> & { iss?: string },
	expected: ProvisioningAffinityV3,
): void {
	if (
		payload.clusterId !== expected.clusterId ||
		payload.workspaceId !== expected.workspaceId ||
		payload.deploymentId !== expected.deploymentId ||
		payload.generationId !== expected.generationId ||
		payload.generationNumber !== expected.generationNumber ||
		payload.runtimeInstallationId !== expected.runtimeInstallationId ||
		payload.iss !== expected.issuer
	) {
		throw new McpProtocolV3Error('GENERATION_AFFINITY_MISMATCH');
	}
	if (
		payload.resourceManifestHash !== expected.resourceManifestHash
	) {
		throw new McpProtocolV3Error('RESOURCE_MANIFEST_HASH_MISMATCH');
	}
}

export function assertGenerationAffinityV3(
	payload: Omit<GenerationAffinityV3, 'issuer'> & { iss?: string },
	expected: GenerationAffinityV3,
): void {
	assertProvisioningAffinityV3(payload, expected);
	if (
		payload.runtimeResourceInventoryHash !== expected.runtimeResourceInventoryHash
	) {
		throw new McpProtocolV3Error('RUNTIME_RESOURCE_INVENTORY_HASH_MISMATCH');
	}
}

export function verifyDeploymentGrantV3(input: {
	compact: string;
	publicJwk: JsonWebKey;
	kid: string;
	expected: DeploymentGrantAffinityV3;
}): McpDeploymentGrantPayloadV3 {
	const payload = verifySignedV3({
		...input,
		typ: 'privos-deployment-grant+jws',
		schema: McpDeploymentGrantPayloadV3Schema,
		maximumLifetimeSeconds: 120,
	});
	assertProvisioningAffinityV3({
		...payload,
		resourceManifestHash: payload.deployment.resourceManifestHash,
	}, input.expected);
	if (
		input.expected.previousGeneration &&
		(payload.generationId === input.expected.previousGeneration.generationId ||
			payload.runtimeInstallationId === input.expected.previousGeneration.runtimeInstallationId ||
			payload.generationNumber <= input.expected.previousGeneration.generationNumber)
	) throw new McpProtocolV3Error('GENERATION_IDENTITY_REUSED');
	return payload;
}

/**
 * Hub-known affinity for the second provisioning handshake. The Cluster-local
 * inventory ID, hash, and count are evidence established by the verified
 * attestation, not values the initial Hub grant can be expected to know.
 */
export type RuntimeInventoryAttestationAffinityV3 = ProvisioningAffinityV3 & {
	deploymentGrantJti: string;
	clusterAppId: string;
	manifestDigest: string;
	inventoryId?: string;
	runtimeResourceInventoryHash?: string;
	expectedResourceCount?: number;
};

export function verifyClusterRuntimeInventoryAttestationV3(input: {
	compact: string;
	publicJwk: JsonWebKey;
	kid: string;
	expected: RuntimeInventoryAttestationAffinityV3;
}): ClusterRuntimeInventoryAttestationPayloadV3 {
	const payload = verifySignedV3({
		...input,
		typ: 'privos-cluster-runtime-inventory-attestation+jws',
		schema: ClusterRuntimeInventoryAttestationPayloadV3Schema,
		maximumLifetimeSeconds: 300,
	});
	assertProvisioningAffinityV3(payload, input.expected);
	if (
		payload.deploymentGrantJti !== input.expected.deploymentGrantJti ||
		payload.clusterAppId !== input.expected.clusterAppId ||
		payload.manifestDigest !== input.expected.manifestDigest ||
		(input.expected.inventoryId !== undefined && payload.inventoryId !== input.expected.inventoryId)
	) throw new McpProtocolV3Error('GENERATION_AFFINITY_MISMATCH');
	if (
		input.expected.runtimeResourceInventoryHash !== undefined &&
		payload.runtimeResourceInventoryHash !== input.expected.runtimeResourceInventoryHash
	) throw new McpProtocolV3Error('RUNTIME_RESOURCE_INVENTORY_HASH_MISMATCH');
	if (
		input.expected.expectedResourceCount !== undefined &&
		payload.expectedResourceCount !== input.expected.expectedResourceCount
	) throw new McpProtocolV3Error('RESOURCE_INVENTORY_COUNT_MISMATCH');
	return payload;
}

export type DispatchAffinityV3 = GenerationAffinityV3 & {
	manifestDigest: string;
	runtimeApprovalReceiptHash: string;
	runtimeGrantEpoch: number;
	authorizationContext: 'workspace' | 'room';
	roomId?: string;
	authorizationBindingId?: string;
	bindingReceiptHash?: string;
	bindingEpoch?: number;
	bodyDigest?: string;
};

export function assertDispatchAffinityV3(
	payload: McpDispatchAssertionPayloadV3,
	expected: DispatchAffinityV3,
): void {
	assertGenerationAffinityV3(payload, expected);
	if (
		payload.manifestDigest !== expected.manifestDigest ||
		payload.runtimeApprovalReceiptHash !== expected.runtimeApprovalReceiptHash ||
		payload.runtimeGrantEpoch !== expected.runtimeGrantEpoch ||
		payload.authorizationContext !== expected.authorizationContext ||
		(expected.bodyDigest !== undefined && payload.bodyDigest !== expected.bodyDigest)
	) throw new McpProtocolV3Error('GENERATION_AFFINITY_MISMATCH');
	if (expected.authorizationContext === 'room') {
		if (
			!expected.roomId || !expected.authorizationBindingId ||
			!expected.bindingReceiptHash || expected.bindingEpoch === undefined
		) {
			throw new McpProtocolV3Error('ROOM_BINDING_REQUIRED');
		}
		if (
			payload.authorizationContext !== 'room' ||
			payload.roomId !== expected.roomId ||
			payload.authorizationBindingId !== expected.authorizationBindingId ||
			payload.bindingReceiptHash !== expected.bindingReceiptHash ||
			payload.bindingEpoch !== expected.bindingEpoch
		) throw new McpProtocolV3Error('ROOM_BINDING_MISMATCH');
	}
}

export function verifyDispatchAssertionV3(input: {
	compact: string;
	publicJwk: JsonWebKey;
	kid: string;
	expected: DispatchAffinityV3;
}): McpDispatchAssertionPayloadV3 {
	const payload = verifySignedV3({
		...input,
		typ: 'privos-hub-dispatch+jws',
		schema: McpDispatchAssertionPayloadV3Schema,
		maximumLifetimeSeconds: 30,
	});
	assertDispatchAffinityV3(payload, input.expected);
	return payload;
}

export function verifyLifecycleCommandV3(input: {
	compact: string;
	publicJwk: JsonWebKey;
	kid: string;
	expected: GenerationAffinityV3;
}): ClusterLifecycleCommandPayloadV3 {
	const payload = verifySignedV3({
		...input,
		typ: 'privos-cluster-lifecycle-command+jws',
		schema: ClusterLifecycleCommandPayloadV3Schema,
		maximumLifetimeSeconds: 300,
	});
	assertGenerationAffinityV3(payload, input.expected);
	return payload;
}

export function verifyReconfigureCommandV3(input: {
	compact: string;
	publicJwk: JsonWebKey;
	kid: string;
	expected: GenerationAffinityV3 & { clusterAppId: string; manifestDigest: string };
}): ClusterReconfigureCommandPayloadV3 {
	const payload = verifySignedV3({
		...input,
		typ: 'privos-cluster-reconfigure-command+jws',
		schema: ClusterReconfigureCommandPayloadV3Schema,
		maximumLifetimeSeconds: 300,
	});
	assertGenerationAffinityV3(payload, input.expected);
	if (
		payload.clusterAppId !== input.expected.clusterAppId ||
		payload.manifestDigest !== input.expected.manifestDigest
	) throw new McpProtocolV3Error('GENERATION_AFFINITY_MISMATCH');
	return payload;
}

/**
 * Unlike reconfigure, the command's own `manifestDigest`-equivalent
 * (`targetManifestDigest`) is NEW by design, so it cannot be checked against
 * what the Cluster already holds the way reconfigure's is. `mcpAppId` stands
 * in as the identity field that must stay fixed across a revision.
 */
export function verifyUpgradeCommandV3(input: {
	compact: string;
	publicJwk: JsonWebKey;
	kid: string;
	expected: GenerationAffinityV3 & { clusterAppId: string; mcpAppId: string };
}): ClusterUpgradeCommandPayloadV3 {
	const payload = verifySignedV3({
		...input,
		typ: 'privos-cluster-upgrade-command+jws',
		schema: ClusterUpgradeCommandPayloadV3Schema,
		maximumLifetimeSeconds: 300,
	});
	assertGenerationAffinityV3(payload, input.expected);
	if (
		payload.clusterAppId !== input.expected.clusterAppId ||
		payload.mcpAppId !== input.expected.mcpAppId
	) throw new McpProtocolV3Error('GENERATION_AFFINITY_MISMATCH');
	return payload;
}

export function verifyNodeCleanupResultV3(input: {
	compact: string;
	publicJwk: JsonWebKey;
	kid: string;
	expected: GenerationAffinityV3;
}): NodeCleanupResultPayloadV3 {
	const payload = verifySignedV3({
		...input,
		typ: 'privos-cluster-node-cleanup-result+jws',
		schema: NodeCleanupResultPayloadV3Schema,
		maximumLifetimeSeconds: 300,
	});
	assertGenerationAffinityV3(payload, input.expected);
	return payload;
}

export function verifyClusterFinalAcknowledgementV3(input: {
	compact: string;
	publicJwk: JsonWebKey;
	kid: string;
	expected: GenerationAffinityV3;
}): ClusterFinalAcknowledgementPayloadV3 {
	const payload = verifySignedV3({
		...input,
		typ: 'privos-cluster-final-cleanup-ack+jws',
		schema: ClusterFinalAcknowledgementPayloadV3Schema,
		maximumLifetimeSeconds: 300,
	});
	assertGenerationAffinityV3(payload, input.expected);
	return payload;
}
