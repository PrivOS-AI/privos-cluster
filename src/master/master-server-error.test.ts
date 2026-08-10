import assert from 'node:assert/strict';
import test from 'node:test';

import { masterErrorResponse } from './master-server.js';

const BOUNDED_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;

test('an untagged Mongo duplicate-key error never leaks its raw text as `error`', () => {
	// Mongo's `code` is a NUMBER — 11000 for a duplicate key — so it is never a string and this
	// error was never classified at a throw site. Before the fix, the handler fell back to the
	// raw message here, which is exactly how a duplicate-key collision reached the Hub with
	// nothing but driver text to map — surfacing to an operator as a bare AUTO_FINALIZATION_FAILED.
	const duplicateKey = Object.assign(
		new Error('E11000 duplicate key error collection: privos_registration.apps_master_apps index: appId_1'),
		{ code: 11000 },
	);

	const response = masterErrorResponse(duplicateKey);

	assert.equal(response.statusCode, 500);
	assert.equal(response.body.error, 'INTERNAL_ERROR');
	assert.match(response.body.error, BOUNDED_ERROR_CODE);
	assert.match(response.body.message, /E11000 duplicate key/);
});

test('a duplicate-key collision tagged at its throw site reports the stable code, not raw text', () => {
	// This is the shape `DeploymentService.deployMcpV3` throws once it has proven the collision
	// is neither a REMOVED tombstone nor a live row it can reconcile against (the 135008 class).
	// Internal reason codes in this service are lowercase snake_case by convention; the handler
	// uppercases them into the wire contract rather than trusting the caller to pre-format them.
	const tagged = Object.assign(new Error('duplicate_app_row'), {
		code: 'duplicate_app_row',
		correlationId: 'generation-abc123',
	});

	const response = masterErrorResponse(tagged);

	assert.equal(response.body.error, 'DUPLICATE_APP_ROW');
	assert.match(response.body.error, BOUNDED_ERROR_CODE);
	assert.equal(response.body.correlationId, 'generation-abc123');
});

test('tagged capacity errors still map to 409 with their exact code unchanged', () => {
	for (const code of ['WORKSPACE_QUOTA_EXCEEDED', 'NODE_CAPACITY_EXHAUSTED', 'HA_REQUIRES_STATELESS_APP']) {
		const response = masterErrorResponse(Object.assign(new Error('nope'), { code }));
		assert.equal(response.statusCode, 409, code);
		assert.equal(response.body.error, code);
	}
});

test('an explicit statusCode wins, and an untagged error becomes INTERNAL_ERROR while keeping its message', () => {
	assert.equal(masterErrorResponse(Object.assign(new Error('bad input'), { statusCode: 400 })).statusCode, 400);

	const plain = masterErrorResponse(new Error('something broke'));
	assert.equal(plain.statusCode, 500);
	assert.equal(plain.body.error, 'INTERNAL_ERROR');
	assert.equal(plain.body.message, 'something broke');
});

test('a value with no message at all still produces a usable body', () => {
	const response = masterErrorResponse({});
	assert.equal(response.statusCode, 500);
	assert.equal(response.body.error, 'INTERNAL_ERROR');
	assert.equal(response.body.message, 'internal error');
});

test('a correlation id is echoed only when present and shaped like one; an untagged error carries none', () => {
	const untagged = masterErrorResponse(new Error('something broke'));
	assert.equal(untagged.body.correlationId, undefined);
	assert.ok(!('correlationId' in untagged.body));

	const valid = masterErrorResponse(Object.assign(new Error('boom'), { correlationId: 'runtime-install-42' }));
	assert.equal(valid.body.correlationId, 'runtime-install-42');
});

test('a malformed or non-string correlationId on the thrown value is dropped, not coerced', () => {
	assert.equal(masterErrorResponse(Object.assign(new Error('nope'), { correlationId: 12345 })).body.correlationId, undefined);
	assert.equal(
		masterErrorResponse(Object.assign(new Error('nope'), { correlationId: 'has a space' })).body.correlationId,
		undefined,
	);
	assert.equal(
		masterErrorResponse(Object.assign(new Error('nope'), { correlationId: 'x'.repeat(65) })).body.correlationId,
		undefined,
	);
});

test('every returned error code matches the bounded wire contract, across every input shape met so far', () => {
	const cases: unknown[] = [
		Object.assign(new Error('e'), { code: 11000, message: 'E11000 ... apps_master_apps ...' }),
		Object.assign(new Error('e'), { code: 'duplicate_app_row' }),
		Object.assign(new Error('e'), { code: 'WORKSPACE_QUOTA_EXCEEDED' }),
		new Error('unstructured failure with no code at all'),
		{},
		Object.assign(new Error('lowercase code should still resolve to a bounded code'), { code: 'not_a_bounded_code' }),
	];
	for (const value of cases) {
		const response = masterErrorResponse(value);
		assert.match(response.body.error, BOUNDED_ERROR_CODE, JSON.stringify(response.body));
	}
});

test('a throw site that carries its reason token as the message keeps that token as the code', () => {
	// Most of this service throws `new Error('some_reason_token')` with no `code`
	// at all. The Hub matches that token and classifies on it, so collapsing these
	// to the fallback would strip real causes the Hub already consumes.
	const identity = masterErrorResponse(Object.assign(new Error('mcp_node_identity_unavailable'), { statusCode: 503 }));
	assert.equal(identity.body.error, 'MCP_NODE_IDENTITY_UNAVAILABLE');
	assert.equal(identity.statusCode, 503);
	assert.equal(identity.body.message, 'mcp_node_identity_unavailable');

	assert.equal(masterErrorResponse(new Error('hub_identity_conflict')).body.error, 'HUB_IDENTITY_CONFLICT');
	assert.equal(masterErrorResponse(new Error('mcp_install_v2_disabled')).body.error, 'MCP_INSTALL_V2_DISABLED');
});

test('free text is never rewritten into a code, however code-shaped it looks after munging', () => {
	// The candidate must already BE a reason token. Rewriting would let prose
	// through: "Some error happened" must not become SOME_ERROR_HAPPENED.
	for (const raw of [
		'Some error happened',
		'E11000 duplicate key error collection: privos_registration.apps_master_apps index: appId_1',
		'connect ECONNREFUSED 10.88.0.11:5000',
		'getaddrinfo EAI_AGAIN tenant-135008-mongo',
	]) {
		const response = masterErrorResponse(new Error(raw));
		assert.equal(response.body.error, 'INTERNAL_ERROR', `leaked: ${response.body.error}`);
		assert.equal(response.body.message, raw);
	}
});
