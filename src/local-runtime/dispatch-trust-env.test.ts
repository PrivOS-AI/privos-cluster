/**
 * Cross-repo contract, cluster side: the env this driver puts in an app
 * container is what the SDK's `runtime-v3` mode parses. The SDK half runs
 * against the sibling checkout's real source when it is present (same
 * convention as `handlers/local-runtime.test.ts`), so a renamed key or a
 * changed affinity shape fails here before it fails on a customer's host.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { validateActivate, validateEnsureReady, canonicalHash } from './abi-schema.js';
import {
	RUNTIME_V3_ALLOW_UNSIGNED_READINESS_ENV_KEY,
	RUNTIME_V3_SECURITY_MODE_ENV_KEY,
	RUNTIME_V3_TRUST_ENV_KEY,
	dispatchTrustEnv,
	envListToMap,
} from './dispatch-trust-env.js';

const SDK_SRC =
	process.env.PRIVOS_APP_SERVER_SRC_DIR ||
	path.resolve(import.meta.dirname, '../../../privos-app-packages/app-server/src');

const ensureReady = validateEnsureReady({
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
	artifact: { path: '/var/lib/privos/marketplace/apps/local-1.privos-app', digest: `sha256:${'d'.repeat(64)}`, size_bytes: 4096 },
	runtime_spec: {
		driver_abi: 'privos-local-runtime-driver-v1',
		artifact_format: 'oci-image-archive-v1',
		port: 3001,
		resources: { memory_mb: 512, cpus: 0.5, tmp_size_mb: 64 },
	},
});

const activate = validateActivate({
	protocol_version: 3,
	operation: 'ACTIVATE',
	runtime_id: `local-runtime-${'0'.repeat(32)}`,
	installation_id: ensureReady.installation_id,
	workspace_id: ensureReady.workspace_id,
	deployment_id: ensureReady.deployment_id,
	listing_id: ensureReady.listing_id,
	version_id: ensureReady.version_id,
	generation_id: ensureReady.generation_id,
	generation_number: ensureReady.generation_number,
	descriptor_artifact_hash: ensureReady.descriptor_artifact_hash,
	resource_manifest_hash: ensureReady.resource_manifest_hash,
	permission_contract_hash: ensureReady.permission_contract_hash,
	runtime_authorization: ensureReady.runtime_authorization,
	artifact_digest: ensureReady.artifact.digest,
	ensure_ready_request_hash: canonicalHash(ensureReady),
	runtime_resource_inventory_hash: 'D'.repeat(43),
	runtime_approval_receipt_hash: 'E'.repeat(43),
	runtime_authorization_epoch: 1,
});

const preactivation = envListToMap(dispatchTrustEnv(ensureReady, null));
const active = envListToMap(dispatchTrustEnv(ensureReady, activate));

test('emits exactly the three runtime-v3 keys; unsigned readiness is on only before activation', () => {
	for (const env of [preactivation, active]) {
		assert.deepEqual(Object.keys(env).sort(), [RUNTIME_V3_ALLOW_UNSIGNED_READINESS_ENV_KEY, RUNTIME_V3_TRUST_ENV_KEY, RUNTIME_V3_SECURITY_MODE_ENV_KEY].sort());
		assert.equal(env[RUNTIME_V3_SECURITY_MODE_ENV_KEY], 'runtime-v3');
	}
	assert.equal(preactivation[RUNTIME_V3_ALLOW_UNSIGNED_READINESS_ENV_KEY], 'true');
	assert.equal(active[RUNTIME_V3_ALLOW_UNSIGNED_READINESS_ENV_KEY], 'false');
});

test('the affinity is the ENSURE_READY tuple, plus the three ACTIVATE fields once activated', () => {
	const before = JSON.parse(preactivation[RUNTIME_V3_TRUST_ENV_KEY]!);
	assert.deepEqual(before, {
		affinity: {
			deploymentId: 'deployment-1',
			executionMode: 'SELF_HOSTED_LOCAL',
			generationId: 'generation-1',
			generationNumber: 1,
			manifestDigest: `sha256:${'a'.repeat(64)}`,
			mcpAppId: 'mcp-app-1',
			resourceManifestHash: 'B'.repeat(43),
			runtimeInstallationId: 'installation-local-1',
			workspaceId: 'workspace-1',
		},
		hubKid: ensureReady.runtime_authorization.hub_kid,
		hubPublicJwk: { crv: 'P-256', kty: 'EC', x: ensureReady.runtime_authorization.hub_public_jwk.x, y: ensureReady.runtime_authorization.hub_public_jwk.y },
	});
	const after = JSON.parse(active[RUNTIME_V3_TRUST_ENV_KEY]!);
	assert.deepEqual(after.affinity, {
		...before.affinity,
		runtimeApprovalReceiptHash: 'E'.repeat(43),
		runtimeAuthorizationEpoch: 1,
		runtimeResourceInventoryHash: 'D'.repeat(43),
	});
});

if (!fs.existsSync(path.join(SDK_SRC, 'runtime-v3-env.ts'))) {
	console.warn(`SKIPPING SDK-side trust-env test: ${SDK_SRC} not found (checkout privos-app-packages as a sibling or set PRIVOS_APP_SERVER_SRC_DIR)`);
} else {
	test('the SDK parses the emitted env verbatim: same keys, same trust, same readiness posture', async () => {
		const sdk = await import(path.join(SDK_SRC, 'runtime-v3-env.ts'));
		assert.equal(sdk.RUNTIME_V3_SECURITY_MODE_ENV_KEY, RUNTIME_V3_SECURITY_MODE_ENV_KEY);
		assert.equal(sdk.RUNTIME_V3_TRUST_ENV_KEY, RUNTIME_V3_TRUST_ENV_KEY);
		assert.equal(sdk.RUNTIME_V3_ALLOW_UNSIGNED_READINESS_ENV_KEY, RUNTIME_V3_ALLOW_UNSIGNED_READINESS_ENV_KEY);
		for (const [env, allowUnsigned] of [[preactivation, true], [active, false]] as const) {
			assert.equal(sdk.isRuntimeV3SecurityModeEnv(env), true);
			const parsed = sdk.parseRuntimeV3Env(env);
			assert.deepEqual(parsed, { trust: JSON.parse(env[RUNTIME_V3_TRUST_ENV_KEY]!), allowUnsignedPreactivationReadiness: allowUnsigned });
		}
	});
}
