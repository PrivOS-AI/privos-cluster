import assert from 'node:assert/strict';
import test from 'node:test';

process.env.FLEET_MODE = 'true';
process.env.HOST = '10.88.0.99';
process.env.FLEET_NODE_ID = 'apps-test-01';
process.env.FLEET_NODE_KEY = 'fleet-node-key-0123456789-0123456789';
process.env.IMAGE_REGISTRY_ALLOWLIST = '10.88.0.11:5000';

const { DeployRequestSchema, RedeployRequestSchema } = await import('./app-schemas.js');

const base = {
	workspaceId: 'workspace-1',
	listingId: 'listing-1',
	versionDigest: `sha256:${'a'.repeat(64)}`,
	image: '10.88.0.11:5000/marketplace/test',
	digest: `sha256:${'b'.repeat(64)}`,
};

test('fleet deploy accepts an omitted or empty optional volume list', () => {
	assert.equal(DeployRequestSchema.safeParse(base).success, true);
	assert.equal(DeployRequestSchema.safeParse({ ...base, volumes: [] }).success, true);
	assert.equal(
		DeployRequestSchema.safeParse({ ...base, volumes: [{ name: 'data', mountPath: '/data', sizeMb: 128 }] }).success,
		true,
	);
});

test('fleet deploy rejects non-data and multiple persistent volumes', () => {
	assert.equal(
		DeployRequestSchema.safeParse({ ...base, volumes: [{ name: 'cache', mountPath: '/cache' }] }).success,
		false,
	);
	assert.equal(
		DeployRequestSchema.safeParse({
			...base,
			volumes: [
				{ name: 'data', mountPath: '/data' },
				{ name: 'cache', mountPath: '/cache' },
			],
		}).success,
		false,
	);
});

test('legacy deploy refuses PRIVOS_* names in envVars, in any letter case', () => {
	for (const name of ['PRIVOS_PUBLIC_URL', 'PRIVOS_APP_PUBLIC_URL', 'PRIVOS_ACCESS_MODE', 'privos_anything', 'PRIVOS_']) {
		const parsed = DeployRequestSchema.safeParse({ ...base, envVars: { [name]: 'x' } });
		assert.equal(parsed.success, false, name);
		assert.deepEqual(parsed.error?.issues[0]?.path, ['envVars', name]);
	}
});

test('legacy deploy still accepts ordinary names and the two agent-bot credential names', () => {
	assert.equal(DeployRequestSchema.safeParse({ ...base, envVars: { API_URL: 'x', NOT_PRIVOS_X: 'y' } }).success, true);
	assert.equal(
		DeployRequestSchema.safeParse({ ...base, envVars: { PRIVOS_AGENT_BOT_CREDENTIAL: 'x', PRIVOS_AGENT_BOT_USER_ID: 'y' } }).success,
		true,
	);
});

test('redeploy refuses PRIVOS_* names through the shared check', () => {
	const parsed = RedeployRequestSchema.safeParse({ workspaceId: 'workspace-1', digest: base.digest, envVars: { PRIVOS_X: '1' } });
	assert.equal(parsed.success, false);
	assert.deepEqual(parsed.error?.issues.map((issue) => issue.path.join('.')), ['envVars.PRIVOS_X']);
});
