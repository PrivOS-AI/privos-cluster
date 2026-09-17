import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ContainerManager, type CreateContainerConfig } from './container-manager.js';

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
