import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRawRedeployAllowedForLabels } from './redeploy-secret-guard.js';

const platformEnvVars = { PRIVOS_PUBLIC_URL: 'https://app.example.com', PRIVOS_ACCESS_MODE: 'managed-runtime' };

test('a plain container with no declared secrets is always allowed', () => {
	assert.doesNotThrow(() => assertRawRedeployAllowedForLabels({}));
	assert.doesNotThrow(() => assertRawRedeployAllowedForLabels({ 'privos.env.secret-keys': '[]' }));
});

test('a naive (non-upgrade) caller is refused against an MCP v3 container, secrets or not', () => {
	assert.throws(() => assertRawRedeployAllowedForLabels({ 'privos.mcp.schema': '3' }), /operator secrets/);
});

test('a naive (non-upgrade) caller is refused against any container that still declares secrets', () => {
	assert.throws(
		() => assertRawRedeployAllowedForLabels({ 'privos.env.secret-keys': '["API_KEY"]' }),
		/operator secrets/,
	);
});

// This is the branch a caller claiming MCP v3 upgrade awareness actually
// reaches (`labels['privos.mcp.schema'] === '3'`) — the previous version of
// this test used labels WITHOUT that field, so it asserted a property the
// code did not have: the awareness bypass was unconditional and this test
// could not have caught it.
test('an upgrade-aware caller that omits an existing secret name is refused, even though it claims awareness', () => {
	const labels = {
		'privos.mcp.schema': '3',
		'privos.env.secret-keys': '["API_KEY"]',
		'privos.env': '{}',
	};
	assert.throws(
		() => assertRawRedeployAllowedForLabels(labels, {
			envVars: { API_KEY: 'value' },
			secretEnvKeys: [], // does NOT declare the existing secret key
			platformEnvVars,
		}),
		/must restate every existing environment key|declare every existing secret key/,
	);
});

test('an upgrade-aware caller that drops an existing secret VALUE (envVars) is refused even though it declares the key', () => {
	const labels = {
		'privos.mcp.schema': '3',
		'privos.env.secret-keys': '["API_KEY"]',
		'privos.env': '{}',
	};
	assert.throws(
		() => assertRawRedeployAllowedForLabels(labels, {
			envVars: {}, // API_KEY is declared as secret but never actually supplied
			secretEnvKeys: ['API_KEY'],
			platformEnvVars,
		}),
		/must restate every existing environment key/,
	);
});

test('an upgrade-aware caller with an empty platform environment is refused — every real MCP v3 app has one', () => {
	const labels = { 'privos.mcp.schema': '3', 'privos.env': '{}' };
	assert.throws(
		() => assertRawRedeployAllowedForLabels(labels, {
			envVars: {},
			secretEnvKeys: [],
			platformEnvVars: {},
		}),
		/platform environment/,
	);
});

test('an upgrade-aware caller that fully restates the existing env, secrets, and platform vars is allowed through', () => {
	const labels = {
		'privos.mcp.schema': '3',
		'privos.env.secret-keys': '["API_KEY"]',
		'privos.env': JSON.stringify({ HRM_COMPANY_NAME: 'Acme' }),
	};
	assert.doesNotThrow(() => assertRawRedeployAllowedForLabels(labels, {
		envVars: { HRM_COMPANY_NAME: 'Acme', API_KEY: 'the-real-secret-value' },
		secretEnvKeys: ['API_KEY'],
		platformEnvVars,
	}));
});

// M1 regression: an earlier version of parseSecretKeyNames swallowed a JSON
// parse error and returned [], so `existingSecretKeys.length === 0` then
// ALLOWED the raw redeploy against a container whose secret-keys label was
// corrupt — silently dropping whatever secrets it actually declared. A
// malformed label must fail CLOSED (refused), for a naive caller and an
// upgrade-aware one alike, never fail open into "treat as no secrets".
test('a corrupt privos.env.secret-keys label is refused outright, not treated as no secrets', () => {
	const corruptLabels = { 'privos.env.secret-keys': '{not valid json' };
	assert.throws(
		() => assertRawRedeployAllowedForLabels(corruptLabels),
		/could not be read/,
	);
	assert.throws(
		() => assertRawRedeployAllowedForLabels({ ...corruptLabels, 'privos.mcp.schema': '3' }, {
			envVars: {},
			secretEnvKeys: [],
			platformEnvVars,
		}),
		/could not be read/,
	);
});

test('a privos.env.secret-keys label that is valid JSON but not an array of strings is refused outright', () => {
	assert.throws(
		() => assertRawRedeployAllowedForLabels({ 'privos.env.secret-keys': '{"API_KEY": true}' }),
		/could not be read/,
	);
	assert.throws(
		() => assertRawRedeployAllowedForLabels({ 'privos.env.secret-keys': '[1, 2, 3]' }),
		/could not be read/,
	);
});

test('a corrupt privos.env label is refused outright, even when privos.env.secret-keys is fine', () => {
	assert.throws(
		() => assertRawRedeployAllowedForLabels({ 'privos.env.secret-keys': '[]', 'privos.env': 'not json at all' }),
		/could not be read/,
	);
});

// '[ ]' is valid JSON (whitespace inside an otherwise-empty array) and parses
// to a genuinely empty array — there is nothing it could be silently
// dropping. This is intentionally NOT refused: it is not malformed, just an
// unusual (but faithfully parseable) serialization of "no secrets declared".
test('"[ ]" (whitespace) parses to a genuinely empty array and is allowed, same as "[]"', () => {
	assert.doesNotThrow(() => assertRawRedeployAllowedForLabels({ 'privos.env.secret-keys': '[ ]' }));
});

test('a non-MCP-v3 container is unaffected by an upgrade context — it always takes the plain secrets check', () => {
	assert.doesNotThrow(() => assertRawRedeployAllowedForLabels({}, {
		envVars: {},
		secretEnvKeys: [],
		platformEnvVars,
	}));
	assert.throws(
		() => assertRawRedeployAllowedForLabels({ 'privos.env.secret-keys': '["API_KEY"]' }, {
			envVars: {},
			secretEnvKeys: [],
			platformEnvVars,
		}),
		/operator secrets/,
	);
});
