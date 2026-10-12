import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { ContainerManager, buildContainerLabels, type CreateContainerConfig } from './container-manager.js';
import { McpDeployRequestV3Schema, McpReconfigureRequestV3Schema, RedeployRequestSchema } from '../schemas/app-schemas.js';
import { mapInspectToContainer } from './docker-state-mapper.js';

/** Minimal fake dockerode client: captures the exact options createAppContainer builds. */
function fakeDocker() {
	let captured: any;
	const docker = {
		createContainer: async (options: any) => {
			captured = options;
			return { inspect: async () => ({ Id: 'docker-container-id' }) };
		},
	};
	return { docker, captured: () => captured };
}

function baseConfig(resources: CreateContainerConfig['resources']): CreateContainerConfig {
	return {
		id: 'cid-1',
		appId: 'app-1',
		containerName: 'app-1-container',
		image: 'nginx',
		tag: 'latest',
		port: 3001,
		resources,
		securityProfile: null,
	};
}

test('createAppContainer sets CpuShares proportional to cpus, alongside NanoCpus', async () => {
	const fake = fakeDocker();
	const manager = new ContainerManager(fake.docker as any);

	await manager.createAppContainer(baseConfig({ memoryMb: 512, cpus: 1, tmpSizeMb: 64 }));
	assert.equal(fake.captured().HostConfig.CpuShares, 1024);
	assert.equal(fake.captured().HostConfig.NanoCpus, 1_000_000_000);

	await manager.createAppContainer(baseConfig({ memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 }));
	assert.equal(fake.captured().HostConfig.CpuShares, 256); // 1024 * 0.25
	assert.equal(fake.captured().HostConfig.NanoCpus, 250_000_000);

	// The XL managed-runtime size package (4 cpus) gets 4x the shares of a 1-cpu app.
	await manager.createAppContainer(baseConfig({ memoryMb: 4096, cpus: 4, tmpSizeMb: 64 }));
	assert.equal(fake.captured().HostConfig.CpuShares, 4096);
});

const RES = { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 };

test('no security profile keeps the default hardened HostConfig', async () => {
	const fake = fakeDocker();
	await new ContainerManager(fake.docker as any).createAppContainer(baseConfig(RES));
	assert.equal(fake.captured().HostConfig.PidsLimit, 100);
	assert.deepEqual(fake.captured().HostConfig.SecurityOpt, ['no-new-privileges:true']);
	assert.equal('privos.securityProfile' in fake.captured().Labels, false);
});

test('browser-sandbox adds the inline seccomp profile and the higher pid limit', async () => {
	const fake = fakeDocker();
	await new ContainerManager(fake.docker as any).createAppContainer({ ...baseConfig(RES), securityProfile: 'browser-sandbox' });
	const hc = fake.captured().HostConfig;
	assert.equal(hc.PidsLimit, 1024);
	assert.equal(hc.SecurityOpt.length, 2);
	assert.equal(hc.SecurityOpt[0], 'no-new-privileges:true');
	assert.ok(hc.SecurityOpt[1].startsWith('seccomp={'));
	const profile = JSON.parse(hc.SecurityOpt[1].slice('seccomp='.length));
	assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
	// The inline profile is exactly the vendored file, not a lossy copy of it.
	const vendored = JSON.parse(fs.readFileSync(new URL('./seccomp/browser-sandbox.json', import.meta.url), 'utf8'));
	assert.deepEqual(profile, vendored);
	assert.ok(!hc.SecurityOpt[1].includes('\n'), 'profile is minified');
	// Everything else stays hardened.
	assert.deepEqual(hc.CapDrop, ['ALL']);
	assert.equal(hc.ReadonlyRootfs, true);
	assert.equal(fake.captured().Labels['privos.securityProfile'], 'browser-sandbox');
});

test('an unknown security profile is refused before any container is created', async () => {
	const fake = fakeDocker();
	await assert.rejects(
		new ContainerManager(fake.docker as any).createAppContainer({ ...baseConfig(RES), securityProfile: 'unconfined' as any }),
		/unknown_security_profile/,
	);
	assert.equal(fake.captured(), undefined);
});

test('request schemas accept only known profiles, null, or no key', () => {
	assert.equal(RedeployRequestSchema.safeParse({ securityProfile: 'browser-sandbox' }).success, true);
	assert.equal(RedeployRequestSchema.safeParse({ securityProfile: null }).success, true);
	assert.equal(RedeployRequestSchema.safeParse({}).success, true);
	assert.equal(RedeployRequestSchema.safeParse({ securityProfile: 'unconfined' }).success, false);
	// The v3 schemas share the same field; a bad value fails on that path before any other check matters.
	for (const schema of [McpDeployRequestV3Schema, McpReconfigureRequestV3Schema]) {
		const issues = schema.safeParse({ securityProfile: 'unconfined' });
		assert.equal(issues.success, false);
		assert.ok(!issues.success && issues.error.issues.some((i) => i.path[0] === 'securityProfile'));
	}
});

test('security profile label round-trips through the state mapper', () => {
	const labels = buildContainerLabels({
		id: 'cid-1', appId: 'app-1', image: 'nginx', tag: 'latest', port: 3001, resources: RES,
		securityProfile: 'browser-sandbox',
	});
	const info = (l: Record<string, string>) => ({
		Id: 'd1', Name: '/n', Created: new Date().toISOString(), Config: { Image: 'nginx:latest', Labels: l },
		State: { Status: 'running' }, HostConfig: {}, NetworkSettings: { Ports: {} }, Mounts: [],
	}) as any;
	assert.equal(mapInspectToContainer(info(labels)).securityProfile, 'browser-sandbox');
	delete labels['privos.securityProfile'];
	assert.equal(mapInspectToContainer(info(labels)).securityProfile, null);
	assert.equal(mapInspectToContainer(info({ ...labels, 'privos.securityProfile': 'bogus' })).securityProfile, null);
});
