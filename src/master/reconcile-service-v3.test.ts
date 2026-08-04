import assert from 'node:assert/strict';
import test from 'node:test';

import { ReconcileService } from './reconcile-service.js';

test('generic boot reconciliation cannot invent or activate v3 replicas after a provisioning crash', async () => {
	let appUpdates = 0;
	let lifecycleUpdates = 0;
	const v3App = { appId: 'cluster-app-1', workspaceId: 'workspace-1', kind: 'mcp-v3', replicas: [], state: 'PROVISIONING' };
	const service = new ReconcileService({
		repositories: {
			workspaces: { find: () => ({ toArray: async () => [{ workspaceId: 'workspace-1' }] }) },
			nodes: { find: () => ({ toArray: async () => [{ nodeId: 'node-1' }] }) },
			apps: {
				findOne: async ({ appId }: { appId: string }) => appId === 'cluster-app-1' ? v3App : null,
				updateOne: async () => { appUpdates += 1; },
			},
			lifecycleEvents: { updateOne: async () => { lifecycleUpdates += 1; } },
		} as any,
		agentClient: {
			request: async () => ({
				status: 200,
				body: [
					{ id: 'container-1', appId: 'cluster-app-1', mcpV3: true },
					{ id: 'orphan-container', appId: 'orphan-v3', mcpV3: true },
				],
			}),
		} as any,
		baseDomain: 'apps.example.com',
	});
	assert.deepEqual(await service.run(), { discovered: 2, repaired: 0, failed: 0 });
	assert.equal(appUpdates, 0);
	assert.equal(lifecycleUpdates, 0);
	assert.equal(v3App.state, 'PROVISIONING');
});
