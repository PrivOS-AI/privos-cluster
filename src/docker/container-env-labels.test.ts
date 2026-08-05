/**
 * Docker labels are readable by anyone who can reach the daemon, so an operator
 * secret placed in `privos.env` is a secret published to every node-local
 * process that can run `docker inspect`. These tests pin the boundary: names in
 * the label, values only in the container's own process environment.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { buildContainerLabels, resolveContainerEnv } from './container-manager.js';

const base = {
	id: 'cid',
	appId: 'app1',
	image: 'registry.example/app',
	tag: 'latest',
	port: 3001,
	resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 },
};

test('a secret env value never reaches a Docker label, only its name does', () => {
	const labels = buildContainerLabels({
		...base,
		envVars: { HRM_COMPANY_NAME: 'Acme GmbH', HRM_SMTP_PASSWORD: 'canary-secret-value' },
		secretEnvKeys: ['HRM_SMTP_PASSWORD'],
	});
	assert.equal(labels['privos.env'], JSON.stringify({ HRM_COMPANY_NAME: 'Acme GmbH' }));
	assert.equal(labels['privos.env.secret-keys'], JSON.stringify(['HRM_SMTP_PASSWORD']));
	assert.ok(
		!Object.values(labels).some((value) => value.includes('canary-secret-value')),
		'no label may carry a secret value',
	);
});

test('the env digest covers the secret half, so drift is still detectable', () => {
	const withSecret = buildContainerLabels({
		...base,
		envVars: { HRM_SMTP_PASSWORD: 'first' },
		secretEnvKeys: ['HRM_SMTP_PASSWORD'],
	});
	const rotated = buildContainerLabels({
		...base,
		envVars: { HRM_SMTP_PASSWORD: 'second' },
		secretEnvKeys: ['HRM_SMTP_PASSWORD'],
	});
	assert.equal(withSecret['privos.env'], rotated['privos.env']);
	assert.notEqual(withSecret['privos.env.digest'], rotated['privos.env.digest']);
	assert.equal(
		withSecret['privos.env.digest'],
		crypto.createHash('sha256').update(JSON.stringify([['HRM_SMTP_PASSWORD', 'first']])).digest('hex'),
	);
});

test('the env digest ignores key insertion order', () => {
	const forward = buildContainerLabels({ ...base, envVars: { A: '1', B: '2' } });
	const reversed = buildContainerLabels({ ...base, envVars: { B: '2', A: '1' } });
	assert.equal(forward['privos.env.digest'], reversed['privos.env.digest']);
});

test('a secret name that is not in the env is ignored rather than declared', () => {
	const labels = buildContainerLabels({
		...base,
		envVars: { HRM_LOCALE: 'de-DE' },
		secretEnvKeys: ['HRM_SMTP_PASSWORD'],
	});
	assert.equal(labels['privos.env'], JSON.stringify({ HRM_LOCALE: 'de-DE' }));
	assert.equal(labels['privos.env.secret-keys'], JSON.stringify([]));
});

test('platform variables reach the process environment and win any collision', () => {
	const env = resolveContainerEnv({
		envVars: { HRM_LOCALE: 'de-DE', PRIVOS_PUBLIC_URL: 'https://attacker.example' },
		platformEnvVars: { PRIVOS_PUBLIC_URL: 'https://app.apps.privos.link', PRIVOS_ACCESS_MODE: 'managed-runtime' },
	});
	assert.deepEqual(env, {
		HRM_LOCALE: 'de-DE',
		PRIVOS_PUBLIC_URL: 'https://app.apps.privos.link',
		PRIVOS_ACCESS_MODE: 'managed-runtime',
	});
});

test('platform variables are not written into the user env label', () => {
	const labels = buildContainerLabels({ ...base, envVars: { HRM_LOCALE: 'de-DE' } });
	assert.equal(labels['privos.env'], JSON.stringify({ HRM_LOCALE: 'de-DE' }));
});

test('the raw redeploy paths refuse a container whose secrets they would drop', async () => {
	// Reconstructing env from `privos.env` is exactly why the label exists, and
	// exactly why a container with secrets cannot be rebuilt that way.
	const { assertRawRedeployAllowedForLabels } = await import('../services/redeploy-secret-guard.js');
	assert.doesNotThrow(() => assertRawRedeployAllowedForLabels({ 'privos.env.secret-keys': '[]' }));
	assert.doesNotThrow(() => assertRawRedeployAllowedForLabels({}));
	assert.throws(
		() => assertRawRedeployAllowedForLabels({ 'privos.mcp.schema': '3' }),
		/holds operator secrets/,
	);
	assert.throws(
		() => assertRawRedeployAllowedForLabels({ 'privos.env.secret-keys': '["HRM_SMTP_PASSWORD"]' }),
		/holds operator secrets/,
	);
});
