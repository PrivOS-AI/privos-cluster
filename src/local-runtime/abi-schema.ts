/**
 * Fail-closed validator for the `privos-local-runtime-driver-v1` ABI —
 * TS port of `infra/local-runtime-driver/privos_local_runtime_driver/contract.py`.
 *
 * Two layers, both mandatory before any Docker call:
 *  1. Structural — the vendored canonical JSON Schema
 *     (`local-runtime-driver-v3.schema.json`, draft 2020-12, compiled with
 *     ajv). Covers: unknown/missing members (`additionalProperties:false` +
 *     `required`), wrong `protocol_version`/`operation`/`state`/`driver_abi`/
 *     `artifact_format`, and every numeric/string range and pattern.
 *  2. Semantic — checks the schema cannot express: the evidence
 *     self-consistency hash (`driver_evidence_hash`/`activation_evidence_hash`/
 *     `removal_evidence_hash` must equal `canonicalHash` of the document with
 *     that field omitted — this is what makes a tampered persisted document
 *     detectable, and is exactly what the canonical vectors'
 *     `invalidReadyEvidence`/`invalidActivationEvidence` fixtures exercise),
 *     and the P-256 `hub_public_jwk` binding (`hub_kid` must equal the JWK's
 *     own thumbprint, and `x`/`y` must be a canonical 32-byte encoding of a
 *     point actually on the P-256 curve).
 *
 * Duplicate JSON members are rejected one layer below this module, by
 * `strictJsonParse` (`canonical.ts`) — callers must parse the wire body with
 * it before handing the result here.
 */
import crypto from 'node:crypto';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
// `ajv-formats`'s CJS/ESM dual-export shape confuses NodeNext default-import
// resolution the same way `ajv/dist/2020.js` does above; its module.exports
// IS the plugin function, so cast rather than fight the type resolution.
import addFormatsModule from 'ajv-formats';
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;

import { canonicalJson, jwkThumbprint, sha256Base64Url } from '../security/artifacts.js';
import { ContractError } from './errors.js';
import schema from './local-runtime-driver-v3.schema.json' with { type: 'json' };

/** `canonicalHash(value)` — sha256, sorted-key/no-whitespace JSON, unpadded base64url. Reuses the protocol-v3 canonicalization already frozen in `security/artifacts.ts`. */
export function canonicalHash(value: unknown): string {
	return sha256Base64Url(canonicalJson(value));
}

export const AFFINITY_FIELDS = [
	'installation_id',
	'workspace_id',
	'deployment_id',
	'listing_id',
	'version_id',
	'generation_id',
	'generation_number',
	'descriptor_artifact_hash',
	'resource_manifest_hash',
	'permission_contract_hash',
	'runtime_authorization',
] as const;

export interface RuntimeAuthorization {
	security_mode: 'runtime-v3';
	hub_kid: string;
	hub_public_jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
	mcp_app_id: string;
	manifest_digest: string;
	allow_unsigned_preactivation_readiness: true;
}

export interface Affinity {
	installation_id: string;
	workspace_id: string;
	deployment_id: string;
	listing_id: string;
	version_id: string;
	generation_id: string;
	generation_number: number;
	descriptor_artifact_hash: string;
	resource_manifest_hash: string;
	permission_contract_hash: string;
	runtime_authorization: RuntimeAuthorization;
}

export interface EnsureReadyRequest extends Affinity {
	protocol_version: 3;
	operation: 'ENSURE_READY';
	artifact: { path: string; digest: string; size_bytes: number };
	runtime_spec: {
		driver_abi: 'privos-local-runtime-driver-v1';
		artifact_format: 'oci-image-archive-v1';
		port: number;
		resources: { memory_mb: number; cpus: number; tmp_size_mb: number };
	};
}

export interface ReadyEvidence extends Affinity {
	protocol_version: 3;
	state: 'READY';
	runtime_id: string;
	artifact_digest: string;
	endpoint: string;
	supervisor: 'DOCKER_UNLESS_STOPPED' | 'SYSTEMD';
	ready_at: number;
	driver_evidence_hash: string;
}

export interface ActivateRequest extends Affinity {
	protocol_version: 3;
	operation: 'ACTIVATE';
	runtime_id: string;
	artifact_digest: string;
	ensure_ready_request_hash: string;
	runtime_resource_inventory_hash: string;
	runtime_approval_receipt_hash: string;
	runtime_authorization_epoch: number;
}

export interface ActiveEvidence extends Affinity {
	protocol_version: 3;
	state: 'ACTIVE';
	runtime_id: string;
	artifact_digest: string;
	ensure_ready_request_hash: string;
	runtime_resource_inventory_hash: string;
	runtime_approval_receipt_hash: string;
	runtime_authorization_epoch: number;
	unsigned_readiness_disabled: true;
	activated_at: number;
	activation_evidence_hash: string;
}

export interface RemoveRequest extends Affinity {
	protocol_version: 3;
	operation: 'REMOVE';
	runtime_id: string;
	artifact_digest: string;
}

export interface AbsentEvidence extends Affinity {
	protocol_version: 3;
	state: 'ABSENT';
	runtime_id: string;
	artifact_digest: string;
	checked_at: number;
	removal_evidence_hash: string;
}

export function affinityFromRequest(request: Affinity): Affinity {
	const source = request as unknown as Record<string, unknown>;
	const result = {} as Record<string, unknown>;
	for (const field of AFFINITY_FIELDS) result[field] = source[field];
	return result as unknown as Affinity;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validateStructure: ValidateFunction = ajv.compile(schema);

function assertStructure(value: unknown): asserts value is Record<string, unknown> {
	if (!validateStructure(value)) {
		const detail = ajv.errorsText(validateStructure.errors, { separator: '; ' });
		throw new ContractError(`local runtime ABI payload failed schema validation: ${detail}`);
	}
}

// --- P-256 hub_public_jwk validation (contract.py's `_p256_public_jwk` / `_canonical_base64url_32`) ---

const P256_COORDINATE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Decodes a base64url string and requires it to re-encode to exactly the same 43-char string (rejects non-canonical padding-bit or length variants) and to represent exactly 32 bytes. */
function assertCanonicalBase64Url32(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !P256_COORDINATE_RE.test(value)) throw new ContractError('invalid P-256 coordinate encoding');
	const raw = Buffer.from(value, 'base64url');
	if (raw.length !== 32 || raw.toString('base64url') !== value) throw new ContractError('non-canonical P-256 coordinate encoding');
}

/** Requires `hub_kid` to equal the JWK's own thumbprint and `x`/`y` to be a real point on the P-256 curve (Node/OpenSSL validates curve membership when constructing the public key). */
function assertRuntimeAuthorization(value: unknown): asserts value is RuntimeAuthorization {
	const authorization = value as RuntimeAuthorization;
	assertCanonicalBase64Url32(authorization.hub_public_jwk.x);
	assertCanonicalBase64Url32(authorization.hub_public_jwk.y);
	try {
		// Node/OpenSSL validates that (x, y) is actually a point on the declared
		// curve when constructing a public key from JWK coordinates — reused here
		// instead of hand-rolled P-256 field arithmetic.
		crypto.createPublicKey({ key: authorization.hub_public_jwk, format: 'jwk' });
	} catch {
		throw new ContractError('hub_public_jwk is not a point on the P-256 curve');
	}
	const expectedKid = jwkThumbprint(authorization.hub_public_jwk);
	if (authorization.hub_kid !== expectedKid) throw new ContractError('hub_kid does not match hub_public_jwk');
}

/** Requires a self-reported evidence hash field to equal `canonicalHash` of the document with that field omitted. */
function assertEvidenceHash(value: Record<string, unknown>, field: string): void {
	const { [field]: hash, ...withoutHash } = value;
	if (typeof hash !== 'string' || canonicalHash(withoutHash) !== hash) {
		throw new ContractError(`${field} does not match the canonical hash of its evidence document`);
	}
}

export function validateEnsureReady(value: unknown): EnsureReadyRequest {
	assertStructure(value);
	if (value.operation !== 'ENSURE_READY') throw new ContractError('operation must be ENSURE_READY');
	assertRuntimeAuthorization(value.runtime_authorization);
	return value as unknown as EnsureReadyRequest;
}

export function validateReady(value: unknown): ReadyEvidence {
	assertStructure(value);
	if (value.state !== 'READY') throw new ContractError('state must be READY');
	assertRuntimeAuthorization(value.runtime_authorization);
	assertEvidenceHash(value, 'driver_evidence_hash');
	return value as unknown as ReadyEvidence;
}

export function validateActivate(value: unknown): ActivateRequest {
	assertStructure(value);
	if (value.operation !== 'ACTIVATE') throw new ContractError('operation must be ACTIVATE');
	assertRuntimeAuthorization(value.runtime_authorization);
	return value as unknown as ActivateRequest;
}

export function validateActive(value: unknown): ActiveEvidence {
	assertStructure(value);
	if (value.state !== 'ACTIVE') throw new ContractError('state must be ACTIVE');
	assertRuntimeAuthorization(value.runtime_authorization);
	assertEvidenceHash(value, 'activation_evidence_hash');
	return value as unknown as ActiveEvidence;
}

export function validateRemove(value: unknown): RemoveRequest {
	assertStructure(value);
	if (value.operation !== 'REMOVE') throw new ContractError('operation must be REMOVE');
	assertRuntimeAuthorization(value.runtime_authorization);
	return value as unknown as RemoveRequest;
}

export function validateAbsent(value: unknown): AbsentEvidence {
	assertStructure(value);
	if (value.state !== 'ABSENT') throw new ContractError('state must be ABSENT');
	assertRuntimeAuthorization(value.runtime_authorization);
	assertEvidenceHash(value, 'removal_evidence_hash');
	return value as unknown as AbsentEvidence;
}
