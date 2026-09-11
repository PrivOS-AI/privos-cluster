/**
 * Canonical-vectors conformance suite for the `privos-local-runtime-driver-v1`
 * ABI. Runs the same vendored vectors file the Hub's own
 * `mcp-local-runtime-driver-v3.tests.ts` uses (wire-contracts.md section (h)):
 * every valid vector must validate to the exact documented shape, and every
 * named tamper in `invalidReadyEvidence`/`invalidActivationEvidence` must be
 * refused with no Docker side effect (these two files never touch Docker).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
	validateAbsent,
	validateActivate,
	validateActive,
	validateEnsureReady,
	validateReady,
	validateRemove,
} from './abi-schema.js';
import { strictJsonParse } from './canonical.js';
import { ContractError } from './errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Recorded in wire-contracts.md (artifacts/wire-contracts.md section (h)) at
// authoring time against the source files in privos-mt-manage. A mismatch
// here means the vendored copy has drifted from its source and must be
// re-synced, never silently accepted.
const EXPECTED_SCHEMA_SHA256 = 'b13bb00bad54941ec235d35aaa045940974619f6d61d0aa9a26c834dfbbd7772';
const EXPECTED_VECTORS_SHA256 = '68c670604662260ef929cec0ec1b8c6d4c9e0ecba3471892d75e4efbef7c45c7';

function sha256File(filename: string): string {
	return crypto.createHash('sha256').update(fs.readFileSync(path.join(HERE, filename))).digest('hex');
}

test('vendored schema matches the recorded source hash', () => {
	assert.equal(sha256File('local-runtime-driver-v3.schema.json'), EXPECTED_SCHEMA_SHA256);
});

test('vendored vectors match the recorded source hash', () => {
	assert.equal(sha256File('local-runtime-driver-vectors.json'), EXPECTED_VECTORS_SHA256);
});

const vectors = JSON.parse(fs.readFileSync(path.join(HERE, 'local-runtime-driver-vectors.json'), 'utf8')) as {
	ensureReady: unknown;
	ready: unknown;
	activate: unknown;
	active: unknown;
	remove: unknown;
	absent: unknown;
	invalidReadyEvidence: Array<{ name: string; field: string; value: unknown }>;
	invalidActivationEvidence: Array<{ name: string; field: string; value: unknown }>;
};

test('valid ENSURE_READY vector validates and round-trips through strict JSON parsing', () => {
	const reparsed = strictJsonParse(JSON.stringify(vectors.ensureReady));
	const result = validateEnsureReady(reparsed);
	assert.equal(result.operation, 'ENSURE_READY');
	assert.equal(result.runtime_spec.driver_abi, 'privos-local-runtime-driver-v1');
});

test('valid READY vector validates (evidence hash self-consistent)', () => {
	const result = validateReady(vectors.ready);
	assert.equal(result.state, 'READY');
	assert.equal(result.endpoint, 'http://25d88c3e6576454fdb2cf6e179d42021.mcp-runtime.internal:3001');
});

test('valid ACTIVATE vector validates', () => {
	const result = validateActivate(vectors.activate);
	assert.equal(result.operation, 'ACTIVATE');
});

test('valid ACTIVE vector validates (activation evidence hash self-consistent)', () => {
	const result = validateActive(vectors.active);
	assert.equal(result.state, 'ACTIVE');
	assert.equal(result.unsigned_readiness_disabled, true);
});

test('valid REMOVE vector validates', () => {
	const result = validateRemove(vectors.remove);
	assert.equal(result.operation, 'REMOVE');
});

test('valid ABSENT vector validates (removal evidence hash self-consistent)', () => {
	const result = validateAbsent(vectors.absent);
	assert.equal(result.state, 'ABSENT');
});

test('duplicate JSON member in an ENSURE_READY body is refused before structural validation', () => {
	const raw = JSON.stringify(vectors.ensureReady);
	// Inject a duplicate top-level member by splicing in a second occurrence
	// of an existing key right after the opening brace.
	const tampered = raw.replace('{', '{"protocol_version":3,');
	assert.throws(() => strictJsonParse(tampered), ContractError);
});

for (const invalid of vectors.invalidReadyEvidence) {
	test(`invalid READY evidence '${invalid.name}' is refused fail-closed`, () => {
		const tampered = { ...(vectors.ready as Record<string, unknown>), [invalid.field]: invalid.value };
		assert.throws(() => validateReady(tampered), ContractError);
	});
}

for (const invalid of vectors.invalidActivationEvidence) {
	test(`invalid ACTIVE evidence '${invalid.name}' is refused fail-closed`, () => {
		const tampered = { ...(vectors.active as Record<string, unknown>), [invalid.field]: invalid.value };
		assert.throws(() => validateActive(tampered), ContractError);
	});
}

test('unknown top-level member is refused (additionalProperties:false)', () => {
	const tampered = { ...(vectors.ensureReady as Record<string, unknown>), unexpected_field: 'x' };
	assert.throws(() => validateEnsureReady(tampered), ContractError);
});

test('missing required member is refused', () => {
	const tampered = { ...(vectors.ensureReady as Record<string, unknown>) };
	delete tampered.runtime_spec;
	assert.throws(() => validateEnsureReady(tampered), ContractError);
});

test('wrong protocol_version is refused', () => {
	const tampered = { ...(vectors.ensureReady as Record<string, unknown>), protocol_version: 4 };
	assert.throws(() => validateEnsureReady(tampered), ContractError);
});

test('wrong driver_abi is refused', () => {
	const tampered = {
		...(vectors.ensureReady as Record<string, any>),
		runtime_spec: { ...(vectors.ensureReady as any).runtime_spec, driver_abi: 'some-other-driver' },
	};
	assert.throws(() => validateEnsureReady(tampered), ContractError);
});

test('wrong artifact_format is refused', () => {
	const tampered = {
		...(vectors.ensureReady as Record<string, any>),
		runtime_spec: { ...(vectors.ensureReady as any).runtime_spec, artifact_format: 'zip' },
	};
	assert.throws(() => validateEnsureReady(tampered), ContractError);
});

test('out-of-range artifact size_bytes is refused', () => {
	const tampered = {
		...(vectors.ensureReady as Record<string, any>),
		artifact: { ...(vectors.ensureReady as any).artifact, size_bytes: 250_000_001 },
	};
	assert.throws(() => validateEnsureReady(tampered), ContractError);
});

test('hub_kid not matching hub_public_jwk thumbprint is refused', () => {
	const tampered = {
		...(vectors.ensureReady as Record<string, any>),
		runtime_authorization: {
			...(vectors.ensureReady as any).runtime_authorization,
			hub_kid: 'A'.repeat(43),
		},
	};
	assert.throws(() => validateEnsureReady(tampered), ContractError);
});

test('non-canonical P-256 x coordinate is refused', () => {
	const tampered = {
		...(vectors.ensureReady as Record<string, any>),
		runtime_authorization: {
			...(vectors.ensureReady as any).runtime_authorization,
			hub_public_jwk: { ...(vectors.ensureReady as any).runtime_authorization.hub_public_jwk, x: 'B'.repeat(43) },
		},
	};
	assert.throws(() => validateEnsureReady(tampered), ContractError);
});
