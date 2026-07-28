import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

// Config validates process.env at import time and process.exit(1)s on failure.
// Load it in a child process with controlled env and assert the exit code.
const REPO_ROOT = new URL('..', import.meta.url).pathname;

function loadConfigWith(env: Record<string, string>): number {
	const result = spawnSync(
		process.execPath,
		['--import', 'tsx', '-e', 'import("./src/config.js").then(() => process.exit(0))'],
		{
			cwd: REPO_ROOT,
			encoding: 'utf8',
			env: {
				...process.env,
				JWT_SECRET: 'test-secret-0123456789',
				FLEET_MODE: 'false',
				PRIVOS_DOMAINS: '',
				REVERSE_PROXY_MODE: 'caddy',
				...env,
			},
		},
	);
	return result.status ?? 1;
}

test('native mode without PRIVOS_DOMAINS fails fast', () => {
	assert.equal(loadConfigWith({ REVERSE_PROXY_MODE: 'native', PRIVOS_DOMAINS: '' }), 1);
});

test('native mode with PRIVOS_DOMAINS boots', () => {
	assert.equal(loadConfigWith({ REVERSE_PROXY_MODE: 'native', PRIVOS_DOMAINS: 'privos.link' }), 0);
});

test('caddy and off modes boot without domains', () => {
	assert.equal(loadConfigWith({ REVERSE_PROXY_MODE: 'caddy', PRIVOS_DOMAINS: '' }), 0);
	assert.equal(loadConfigWith({ REVERSE_PROXY_MODE: 'off', PRIVOS_DOMAINS: '' }), 0);
});

test('fleet mode requires a non-empty registry allowlist', () => {
	const fleet = {
		FLEET_MODE: 'true',
		HOST: '10.88.0.99',
		FLEET_NODE_ID: 'apps-eu-01',
		FLEET_NODE_KEY: 'fleet-node-key-0123456789-0123456789',
	};
	assert.equal(loadConfigWith({ ...fleet, IMAGE_REGISTRY_ALLOWLIST: '' }), 1);
	assert.equal(
		loadConfigWith({
			...fleet,
			IMAGE_REGISTRY_ALLOWLIST: '10.88.0.11:5000',
		}),
		0,
	);
});

test('fleet mode requires a per-node key and WireGuard bind', () => {
	assert.equal(loadConfigWith({
		FLEET_MODE: 'true',
		HOST: '0.0.0.0',
		IMAGE_REGISTRY_ALLOWLIST: '10.88.0.11:5000',
	}), 1);
	assert.equal(loadConfigWith({
		FLEET_MODE: 'true',
		HOST: '10.88.0.99',
		FLEET_NODE_ID: 'apps-eu-01',
		FLEET_NODE_KEY: 'fleet-node-key-0123456789-0123456789',
		IMAGE_REGISTRY_ALLOWLIST: '10.88.0.11:5000',
	}), 0);
});
