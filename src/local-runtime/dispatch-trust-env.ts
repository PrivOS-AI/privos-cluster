/**
 * The three env variables the local-runtime driver hands an app container so
 * the SDK's `runtime-v3` mode can verify the Hub's signed dispatch
 * (`hub-runtime-dispatch-assertion`) and, before activation only, accept the
 * unsigned readiness triple. The SDK parses exactly these keys
 * (`app-server/src/runtime-v3-env.ts`) and pins the affinity object field for
 * field against every signed assertion (`workload/dispatch-assertion.ts`).
 *
 * Pure on purpose — no Docker, ledger or broker imports — so the Hub's
 * cross-repo dispatch test can feed this function's real output into the
 * SDK's real verifier.
 */
import type { ActivateRequest, EnsureReadyRequest } from './abi-schema.js';

export const RUNTIME_V3_SECURITY_MODE_ENV_KEY = 'PRIVOS_RUNTIME_SECURITY_MODE';
export const RUNTIME_V3_TRUST_ENV_KEY = 'PRIVOS_RUNTIME_DISPATCH_TRUST_V3';
export const RUNTIME_V3_ALLOW_UNSIGNED_READINESS_ENV_KEY = 'PRIVOS_RUNTIME_ALLOW_UNSIGNED_PREACTIVATION_READINESS';

// Local mirror of the sorted-key canonicalization `security/artifacts.ts`'s
// `canonicalJson` already performs — reused here via the sha256-hex form
// (not base64url) because `_runtime_id` in the reference driver hashes the
// same canonical bytes with a plain hex digest, not the base64url evidence hash.
export function sortedCanonical(value: unknown): unknown {
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

export function dispatchTrustEnv(request: EnsureReadyRequest, activation: ActivateRequest | null): string[] {
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
		`${RUNTIME_V3_SECURITY_MODE_ENV_KEY}=runtime-v3`,
		`${RUNTIME_V3_TRUST_ENV_KEY}=${JSON.stringify(sortedCanonical(trust))}`,
		`${RUNTIME_V3_ALLOW_UNSIGNED_READINESS_ENV_KEY}=${activation ? 'false' : 'true'}`,
	];
}

/** Parses the `KEY=value` lines `dispatchTrustEnv` emits back into an env map (what the container process sees). */
export function envListToMap(env: readonly string[]): Record<string, string> {
	return Object.fromEntries(
		env.map((entry) => {
			const separator = entry.indexOf('=');
			return [entry.slice(0, separator), entry.slice(separator + 1)];
		}),
	);
}
