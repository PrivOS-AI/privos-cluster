import assert from 'node:assert/strict';
import test from 'node:test';

import { loadMasterConfig, parseSecurityProfileAllowlist } from './config.js';

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		MASTER_MONGODB_URL: 'mongodb://localhost:27017',
		APP_MASTER_SERVICE_KEY: 's'.repeat(32),
		APP_MASTER_KEY_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64'),
		...overrides,
	};
}

test('public-hostnames flags default to inert (a fleet that has not rolled behaves byte-identically)', () => {
	const config = loadMasterConfig(environment());
	assert.equal(config.MCP_V3_NO_DEFAULT_HOST, 'off');
	assert.equal(config.MCP_EMIT_APP_PUBLIC_URL, 'off');
	assert.equal(config.MCP_LEGACY_PUBLIC_URL_ALIAS, 'on');
	assert.equal(config.APP_HOST_SUSPEND_CF_RETENTION_DAYS, 30);
	assert.equal(config.CF_APPS_SAAS_API_TOKEN, undefined);
});

test('MCP_V3_NO_DEFAULT_HOST, MCP_EMIT_APP_PUBLIC_URL and MCP_LEGACY_PUBLIC_URL_ALIAS only accept on/off', () => {
	assert.equal(loadMasterConfig(environment({ MCP_V3_NO_DEFAULT_HOST: 'on' })).MCP_V3_NO_DEFAULT_HOST, 'on');
	assert.equal(loadMasterConfig(environment({ MCP_EMIT_APP_PUBLIC_URL: 'on' })).MCP_EMIT_APP_PUBLIC_URL, 'on');
	assert.equal(loadMasterConfig(environment({ MCP_LEGACY_PUBLIC_URL_ALIAS: 'off' })).MCP_LEGACY_PUBLIC_URL_ALIAS, 'off');
	assert.throws(() => loadMasterConfig(environment({ MCP_V3_NO_DEFAULT_HOST: 'yes' })));
	assert.throws(() => loadMasterConfig(environment({ MCP_EMIT_APP_PUBLIC_URL: 'yes' })));
	assert.throws(() => loadMasterConfig(environment({ MCP_LEGACY_PUBLIC_URL_ALIAS: 'maybe' })));
});

test('APP_HOST_SUSPEND_CF_RETENTION_DAYS coerces and accepts 0 (DEV E2E)', () => {
	assert.equal(loadMasterConfig(environment({ APP_HOST_SUSPEND_CF_RETENTION_DAYS: '0' })).APP_HOST_SUSPEND_CF_RETENTION_DAYS, 0);
	assert.equal(loadMasterConfig(environment({ APP_HOST_SUSPEND_CF_RETENTION_DAYS: '7' })).APP_HOST_SUSPEND_CF_RETENTION_DAYS, 7);
	assert.throws(() => loadMasterConfig(environment({ APP_HOST_SUSPEND_CF_RETENTION_DAYS: '-1' })));
});

test('CF_APPS_SAAS_API_TOKEN is optional and independent of CF_APPS_API_TOKEN', () => {
	const config = loadMasterConfig(environment({ CF_APPS_SAAS_API_TOKEN: 'saas-token' }));
	assert.equal(config.CF_APPS_SAAS_API_TOKEN, 'saas-token');
	assert.equal(config.CF_APPS_API_TOKEN, undefined);
});

test('security profile allowlist is empty and the emit flag off by default', () => {
	const config = loadMasterConfig(environment());
	assert.equal(config.MCP_V3_SECURITY_PROFILE_ALLOWLIST, '');
	assert.equal(config.MCP_V3_EMIT_SECURITY_PROFILE, 'off');
	assert.equal(parseSecurityProfileAllowlist(config.MCP_V3_SECURITY_PROFILE_ALLOWLIST).size, 0);
	assert.throws(() => loadMasterConfig(environment({ MCP_V3_EMIT_SECURITY_PROFILE: 'yes' })));
});

test('security profile allowlist parses profile:listingId entries', () => {
	const config = loadMasterConfig(environment({
		MCP_V3_SECURITY_PROFILE_ALLOWLIST: ' browser-sandbox:listing-a , browser-sandbox:listing-b ',
	}));
	const parsed = parseSecurityProfileAllowlist(config.MCP_V3_SECURITY_PROFILE_ALLOWLIST);
	assert.deepEqual([...parsed], [['listing-a', 'browser-sandbox'], ['listing-b', 'browser-sandbox']]);
});

test('malformed allowlist entries and unknown profile names fail config load', () => {
	for (const bad of ['listing-a', 'browser-sandbox:', ':listing-a', 'unconfined:listing-a', 'browser-sandbox:a,,browser-sandbox:b',
		'browser-sandbox:a,browser-sandbox:a', 'browser-sandbox:bad id']) {
		assert.throws(() => loadMasterConfig(environment({ MCP_V3_SECURITY_PROFILE_ALLOWLIST: bad })), Error, bad);
	}
});
