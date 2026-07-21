import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildContainerLabels, HEALTH_DEFAULTS } from './container-manager.js';
import { mapInspectToContainer, mapState } from './docker-state-mapper.js';

// Minimal Docker inspect stub carrying the fields the mapper reads.
function inspect(overrides: any = {}): any {
	return {
		Id: 'docker-abc123',
		Name: '/todo-7f3a9b',
		Created: '2026-07-21T10:00:00.000Z',
		State: { Status: 'running', StartedAt: '2026-07-21T10:00:05.000Z', FinishedAt: '0001-01-01T00:00:00Z' },
		Config: {
			// Config.Env carries image-baked vars + injected PORT — the mapper must
			// IGNORE this and read user env from the privos.env label instead.
			Image: 'nginx:1.27',
			Env: ['PATH=/usr/bin', 'PORT=3001', 'FOO=bar'],
			Labels: {
				'privos.managed': 'true',
				'privos.id': '11111111-2222-3333-4444-555555555555',
				'privos.app-id': 'my-app',
				'privos.image': 'nginx',
				'privos.tag': '1.27',
				'privos.port': '3001',
				'privos.resources': JSON.stringify({ memoryMb: 512, cpus: 1, tmpSizeMb: 128 }),
				'privos.env': JSON.stringify({ FOO: 'bar' }),
				'privos.subdomain': 'todo',
				'privos.domain': 'apps.example.com',
				'privos.created-at': '1700000000000',
			},
		},
		NetworkSettings: { Ports: { '3001/tcp': [{ HostPort: '49155' }] } },
		Mounts: [{ Type: 'volume', Name: 'mcp-vol-11111111-222-data', Destination: '/app/data' }],
		...overrides,
	};
}

test('mapInspectToContainer maps labels + inspect to the Container view', () => {
	const c = mapInspectToContainer(inspect());
	assert.equal(c.id, '11111111-2222-3333-4444-555555555555');
	assert.equal(c.appId, 'my-app');
	assert.equal(c.dockerContainerId, 'docker-abc123');
	assert.equal(c.dockerContainerName, 'todo-7f3a9b');
	assert.equal(c.image, 'nginx');
	assert.equal(c.tag, '1.27');
	assert.equal(c.port, 3001);
	assert.equal(c.state, 'running');
	assert.equal(c.hostPort, 49155);
	assert.equal(c.internalUrl, 'http://localhost:49155');
	assert.deepEqual(c.resources, { memoryMb: 512, cpus: 1, tmpSizeMb: 128 });
	// Only the user env from privos.env — NOT the image-baked PATH or injected PORT.
	assert.deepEqual(c.envVars, { FOO: 'bar' });
	assert.equal(c.subdomain, 'todo');
	assert.equal(c.domain, 'apps.example.com');
	assert.equal(c.createdAt, 1700000000000);
	assert.equal(c.stoppedAt, null);
	assert.deepEqual(c.volumes, [{ name: 'data', mountPath: '/app/data' }]);
});

test('empty-string labels map to null (subdomain/domain/appId)', () => {
	const c = mapInspectToContainer(
		inspect({ Config: { ...inspect().Config, Labels: { ...inspect().Config.Labels, 'privos.subdomain': '', 'privos.domain': '', 'privos.app-id': '' } } }),
	);
	assert.equal(c.subdomain, null);
	assert.equal(c.domain, null);
	assert.equal(c.appId, null);
});

test('stopped container has no internalUrl and derives stoppedAt', () => {
	const c = mapInspectToContainer(
		inspect({ State: { Status: 'exited', StartedAt: '2026-07-21T10:00:05.000Z', FinishedAt: '2026-07-21T11:00:00.000Z' } }),
	);
	assert.equal(c.state, 'stopped');
	assert.equal(c.internalUrl, '');
	assert.equal(c.stoppedAt, new Date('2026-07-21T11:00:00.000Z').getTime());
});

test('mapState covers docker statuses', () => {
	assert.equal(mapState('running'), 'running');
	assert.equal(mapState('restarting'), 'running');
	assert.equal(mapState('created'), 'created');
	assert.equal(mapState('exited'), 'stopped');
	assert.equal(mapState('paused'), 'stopped');
	assert.equal(mapState('weird'), 'error');
	assert.equal(mapState(undefined), 'error');
});

test('malformed privos.resources falls back to defaults; missing image labels parse Config.Image', () => {
	const c = mapInspectToContainer(
		inspect({
			Config: {
				Image: 'redis:7',
				Env: [],
				Labels: { 'privos.managed': 'true', 'privos.id': 'x', 'privos.port': '6379', 'privos.resources': '{not json' },
			},
			NetworkSettings: { Ports: {} },
			Mounts: [],
		}),
	);
	assert.deepEqual(c.resources, { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 });
	assert.equal(c.image, 'redis');
	assert.equal(c.tag, '7');
	assert.equal(c.hostPort, null);
});

test('health provider overlay replaces default counters', () => {
	const c = mapInspectToContainer(inspect(), { status: 'unhealthy', failCount: 2, restartCount: 1, lastCheck: 123 });
	assert.deepEqual(c.healthCheck, { status: 'unhealthy', failCount: 2, restartCount: 1, lastCheck: 123 });
});

test('buildContainerLabels writes the full privos.* schema + caddy when routed', () => {
	const labels = buildContainerLabels({
		id: 'cid',
		appId: 'app1',
		image: 'nginx',
		tag: 'latest',
		port: 3001,
		resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 },
		envVars: { FOO: 'bar' },
		subdomain: 'todo',
		baseDomain: 'apps.example.com',
		createdAt: 42,
	});
	assert.equal(labels['privos.env'], JSON.stringify({ FOO: 'bar' }));
	assert.equal(labels['privos.managed'], 'true');
	assert.equal(labels['privos.id'], 'cid');
	assert.equal(labels['privos.app-id'], 'app1');
	assert.equal(labels['privos.port'], '3001');
	assert.equal(labels['privos.resources'], JSON.stringify({ memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 }));
	assert.equal(labels['privos.subdomain'], 'todo');
	assert.equal(labels['privos.domain'], 'apps.example.com');
	assert.equal(labels['privos.created-at'], '42');
	assert.equal(labels['privos.health.max-fails'], String(HEALTH_DEFAULTS.maxFails));
	assert.equal(labels['privos.health.restart'], 'true');
	assert.equal(labels.caddy, 'todo.apps.example.com');
	assert.equal(labels['privos.public-host'], 'todo.apps.example.com');
});

test('buildContainerLabels without subdomain emits no caddy/public-host and empty routing labels', () => {
	const labels = buildContainerLabels({
		id: 'cid',
		appId: '',
		image: 'redis',
		tag: '7',
		port: 6379,
		resources: { memoryMb: 128, cpus: 0.25, tmpSizeMb: 32 },
	});
	assert.equal(labels.caddy, undefined);
	assert.equal(labels['privos.public-host'], undefined);
	assert.equal(labels['privos.subdomain'], '');
	assert.equal(labels['privos.app-id'], '');
});
