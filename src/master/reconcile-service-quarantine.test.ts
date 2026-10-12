import assert from 'node:assert/strict';
import test from 'node:test';

import { ReconcileService } from './reconcile-service.js';

function build(containers: Array<{ id: string; appId: string; state: string }>, stopStatus = 200) {
	const requests: Array<{ method: string; path: string }> = [];
	let appUpdates = 0;
	const app = { appId: 'app-1', workspaceId: 'ws-1', state: 'QUARANTINED', replicas: [] };
	const service = new ReconcileService({
		repositories: {
			workspaces: { find: () => ({ toArray: async () => [{ workspaceId: 'ws-1' }] }) },
			nodes: { find: () => ({ toArray: async () => [{ nodeId: 'node-1' }] }) },
			apps: { findOne: async () => app, updateOne: async () => { appUpdates += 1; } },
			lifecycleEvents: { updateOne: async () => undefined },
		} as any,
		agentClient: {
			request: async (_node: unknown, _ws: string, method: string, path: string) => {
				requests.push({ method, path });
				if (method === 'GET') return { status: 200, body: containers };
				if (stopStatus === -1) throw new Error('network down');
				return { status: stopStatus, body: {} };
			},
		} as any,
		baseDomain: 'apps.example.com',
	});
	return { service, requests, app, updates: () => appUpdates };
}

test('a running container of a quarantined app is stopped again, and the app state is untouched', async () => {
	const h = build([{ id: 'c1', appId: 'app-1', state: 'running' }]);
	assert.deepEqual(await h.service.run(), { discovered: 1, repaired: 0, failed: 0 });
	assert.deepEqual(h.requests.filter((r) => r.method === 'POST'), [{ method: 'POST', path: '/api/v1/apps/c1/stop' }]);
	assert.equal(h.app.state, 'QUARANTINED');
	assert.equal(h.updates(), 0);
});

test('an already stopped container of a quarantined app triggers no stop', async () => {
	const h = build([{ id: 'c1', appId: 'app-1', state: 'exited' }]);
	await h.service.run();
	assert.equal(h.requests.some((r) => r.method === 'POST'), false);
});

test('a failing stop is logged, not thrown, and reconcile carries on', async () => {
	for (const status of [500, -1]) {
		const h = build([{ id: 'c1', appId: 'app-1', state: 'running' }, { id: 'c2', appId: 'app-1', state: 'running' }], status);
		assert.deepEqual(await h.service.run(), { discovered: 2, repaired: 0, failed: 0 });
		assert.equal(h.requests.filter((r) => r.method === 'POST').length, 2);
	}
});
