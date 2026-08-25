import assert from 'node:assert/strict';
import test from 'node:test';

import { AppLifecycleService } from './app-lifecycle-service.js';
import type { MasterApp } from './types.js';

const mcpApp: MasterApp = {
	appId: 'cluster-app-1',
	workspaceId: 'workspace-1',
	listingId: 'listing-1',
	versionDigest: 'sha256:version',
	image: 'registry.internal/example@sha256:image',
	imageDigest: 'sha256:image',
	resources: { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 },
	port: 3000,
	envVars: {},
	volumes: [],
	storageBytes: 0,
	availabilityTier: 'single',
	stateless: true,
	subdomain: 'mcp-app-1',
	uiUrl: 'https://mcp-app-1.example.test',
	replicas: [],
	state: 'RUNNING',
	createdAt: new Date('2026-08-02T00:00:00.000Z'),
	updatedAt: new Date('2026-08-02T00:00:00.000Z'),
	kind: 'mcp-v2',
	mcpInstallationId: 'installation-1',
};

test('generic redeploy cannot mutate an MCP v2 workload without a signed grant', async () => {
	const lifecycle = new AppLifecycleService({
		repositories: {
			apps: { findOne: async () => mcpApp },
		} as never,
		agentClient: {} as never,
		ingress: {} as never,
	});

	await assert.rejects(
		lifecycle.redeploy('workspace-1', 'cluster-app-1', { image: 'attacker.invalid/latest' }),
		(error: unknown) =>
			error instanceof Error &&
			(error as Error & { code?: string; statusCode?: number }).code === 'MCP_SIGNED_REDEPLOYMENT_REQUIRED' &&
			(error as Error & { code?: string; statusCode?: number }).statusCode === 409,
	);
});

test('Hub-facing v3 app views do not expose Cluster-owned replica routing identifiers', async () => {
	const v3App: MasterApp = {
		...mcpApp,
		kind: 'mcp-v3',
		protocolVersion: 3,
		mcpInstallationId: undefined,
		mcpRuntimeInstallationId: 'runtime-1',
		replicas: [{
			replicaId: '11111111-1111-4111-8111-111111111111',
			nodeId: 'node-1',
			containerId: '22222222-2222-4222-8222-222222222222',
			state: 'running',
		}],
	};
	const lifecycle = new AppLifecycleService({
		repositories: { apps: { findOne: async () => v3App } } as never,
		agentClient: {} as never,
		ingress: {} as never,
	});
	const view = await lifecycle.get('workspace-1', 'cluster-app-1') as Record<string, unknown>;
	assert.equal(view.replicaCount, 1);
	assert.equal(view.replicas, undefined);
	await assert.rejects(
		lifecycle.remove('workspace-1', 'cluster-app-1'),
		(error: unknown) =>
			error instanceof Error &&
			(error as Error & { code?: string; statusCode?: number }).code === 'MCP_SIGNED_LIFECYCLE_REQUIRED' &&
			(error as Error & { code?: string; statusCode?: number }).statusCode === 409,
	);
});

/**
 * Workspace power has to reach v3 apps.
 *
 * `invoke` refuses `mcp-v3` because its LIFECYCLE transitions need a signed Hub
 * command. Power is not a lifecycle transition, and demanding a signed Hub
 * command here would be unsatisfiable anyway — the Hub being suspended is the
 * reason we are stopping the app. Tenant 060003's container ran on for over a
 * day against a dead Hub because nothing propagated the suspension.
 */
const v3App: MasterApp = {
	...mcpApp,
	appId: 'cluster-app-v3',
	kind: 'mcp-v3',
	protocolVersion: 3,
	mcpRuntimeInstallationId: 'runtime-1',
	replicas: [
		{ replicaId: 'r-1', nodeId: 'node-1', containerId: 'container-1', state: 'running' },
	] as MasterApp['replicas'],
};

function powerFixture(apps: MasterApp[]) {
	const calls: string[] = [];
	const updates: Array<{ filter: any; update: any }> = [];
	const events: any[] = [];
	const lifecycle = new AppLifecycleService({
		repositories: {
			apps: {
				find: () => ({ toArray: async () => apps }),
				updateOne: async (filter: any, update: any) => { updates.push({ filter, update }); },
			},
			nodes: { find: () => ({ toArray: async () => [{ nodeId: 'node-1', status: 'ACTIVE' }] }) },
			lifecycleEvents: { insertMany: async (rows: any[]) => { events.push(...rows); } },
		} as never,
		agentClient: {
			request: async (_node: unknown, _ws: string, method: string, path: string) => {
				calls.push(`${method} ${path}`);
				return { status: 200, body: {} };
			},
		} as never,
		ingress: {} as never,
	});
	return { lifecycle, calls, updates, events };
}

test('suspending a workspace stops its v3 app and marks why it stopped', async () => {
	const state = powerFixture([v3App]);

	const result = await state.lifecycle.setWorkspacePower('workspace-1', 'suspend');

	assert.equal(result.affected, 1);
	assert.deepEqual(state.calls, ['POST /api/v1/apps/container-1/stop']);
	assert.equal(state.updates[0]!.update.$set.state, 'STOPPED');
	assert.equal(state.updates[0]!.update.$set.suspendedWithWorkspace, true);
	assert.equal(state.events[0]!.type, 'STOPPED');
	// Identity is untouched: this is power, not lifecycle.
	for (const key of ['mcpRuntimeInstallationId', 'mcpAuthorizationEpoch', 'mcpGenerationId']) {
		assert.equal(key in state.updates[0]!.update.$set, false, `${key} must not be touched by a power change`);
	}
});

test('resuming clears the marker and starts the app again', async () => {
	const state = powerFixture([{ ...v3App, state: 'STOPPED', suspendedWithWorkspace: true }]);

	const result = await state.lifecycle.setWorkspacePower('workspace-1', 'resume');

	assert.equal(result.affected, 1);
	assert.deepEqual(state.calls, ['POST /api/v1/apps/container-1/start']);
	assert.equal(state.updates[0]!.update.$set.state, 'RUNNING');
	assert.deepEqual(state.updates[0]!.update.$unset, { suspendedWithWorkspace: '' });
	assert.equal(state.events[0]!.type, 'STARTED');
});

test('a workspace with nothing to move is a no-op, not an error', async () => {
	const state = powerFixture([]);

	const result = await state.lifecycle.setWorkspacePower('workspace-1', 'suspend');

	assert.equal(result.affected, 0);
	assert.deepEqual(state.calls, []);
});

/**
 * Workspace revocation has to reach v3 apps for the same reason power does: the Hub whose
 * signature the rule demands is being destroyed with the workspace. Until this existed, a
 * tenant that had ever installed a v3 app could not be offboarded at all — the Portal's
 * revoke returned 409 and the tenant's stack, buckets and secrets outlived the account.
 */
test('workspace revocation QUARANTINES a v3 app (stops + retains, does not destroy)', async () => {
	const revokedApp: MasterApp = {
		...mcpApp,
		kind: 'mcp-v3',
		protocolVersion: 3,
		mcpInstallationId: undefined,
		mcpRuntimeInstallationId: 'runtime-1',
		replicas: [{
			replicaId: '11111111-1111-4111-8111-111111111111',
			nodeId: 'node-1',
			containerId: '22222222-2222-4222-8222-222222222222',
			state: 'running',
		}],
	};
	const sets: Array<Record<string, unknown>> = [];
	const paths: string[] = [];
	let ingressRemoved = false;
	const lifecycle = new AppLifecycleService({
		repositories: {
			apps: {
				findOne: async () => revokedApp,
				updateOne: async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
					sets.push(update.$set);
				},
			},
			nodes: { find: () => ({ toArray: async () => [{ nodeId: 'node-1', address: 'https://node-1.internal' }] }) },
			lifecycleEvents: { insertMany: async () => undefined },
		} as never,
		agentClient: {
			request: async (_node: unknown, _workspaceId: string, _method: string, path: string) => {
				paths.push(path);
				return { status: 200, body: {} };
			},
		} as never,
		ingress: { remove: async () => { ingressRemoved = true; } } as never,
	});

	await lifecycle.remove('workspace-1', 'cluster-app-1', { workspaceRevoked: true });

	// Quarantine, not destroy: state QUARANTINED with the grace clock started,
	// the container STOPPED (not deleted), and ingress left intact.
	assert.deepEqual(sets.map((s) => s.state), ['QUARANTINED']);
	assert.ok(sets[0].quarantinedAt instanceof Date);
	assert.equal(paths.length, 1);
	assert.match(paths[0], /\/stop$/);
	assert.equal(ingressRemoved, false);
});

test('the reaper destroys a quarantined app; un-quarantine restarts it', async () => {
	const quarantinedApp: MasterApp = {
		...mcpApp,
		kind: 'mcp-v3',
		protocolVersion: 3,
		state: 'QUARANTINED',
		quarantinedAt: new Date('2026-08-01T00:00:00Z'),
		replicas: [{ replicaId: '11111111-1111-4111-8111-111111111111', nodeId: 'node-1', containerId: 'c-1', state: 'stopped' }],
	} as MasterApp;
	const makeLifecycle = (opts: { nodeGone?: boolean; deleteStatus?: number } = {}) => {
		const sets: Array<Record<string, unknown>> = [];
		const unsets: Array<Record<string, unknown>> = [];
		const paths: string[] = [];
		let ingressRemoved = false;
		const lifecycle = new AppLifecycleService({
			repositories: {
				apps: {
					findOne: async () => quarantinedApp,
					// Atomic claim: the QUARANTINED-guarded updateOne "wins" (modifiedCount 1).
					updateOne: async (_f: unknown, update: { $set?: Record<string, unknown>; $unset?: Record<string, unknown> }) => {
						if (update.$set) sets.push(update.$set);
						if (update.$unset) unsets.push(update.$unset);
						return { modifiedCount: 1 };
					},
				},
				nodes: { find: () => ({ toArray: async () => (opts.nodeGone ? [] : [{ nodeId: 'node-1', address: 'https://node-1.internal' }]) }) },
				lifecycleEvents: { insertMany: async () => undefined },
			} as never,
			agentClient: { request: async (_n: unknown, _w: string, _m: string, path: string) => { paths.push(path); return { status: opts.deleteStatus ?? 200, body: {} }; } } as never,
			ingress: { remove: async () => { ingressRemoved = true; } } as never,
		});
		return { lifecycle, sets, unsets, paths, ingressRemoved: () => ingressRemoved };
	};

	// Reap → full destroy (ends REMOVED, DELETEs the container).
	const reap = makeLifecycle();
	await reap.lifecycle.reapQuarantined('workspace-1', 'cluster-app-1');
	assert.ok(reap.sets.some((s) => s.state === 'REMOVED'));
	assert.equal(reap.paths.filter((p) => !/\/(stop|start)$/.test(p)).length, 1); // one DELETE

	// H1: reap tolerates a gone node — still reaches REMOVED + frees ingress, no DELETE call.
	const reapGone = makeLifecycle({ nodeGone: true });
	await reapGone.lifecycle.reapQuarantined('workspace-1', 'cluster-app-1');
	assert.ok(reapGone.sets.some((s) => s.state === 'REMOVED'));
	assert.equal(reapGone.ingressRemoved(), true);
	assert.equal(reapGone.paths.length, 0);

	// H1: reap tolerates an already-absent container (DELETE 404) — still REMOVED.
	const reap404 = makeLifecycle({ deleteStatus: 404 });
	await reap404.lifecycle.reapQuarantined('workspace-1', 'cluster-app-1');
	assert.ok(reap404.sets.some((s) => s.state === 'REMOVED'));

	// Un-quarantine → RUNNING, quarantinedAt cleared, container started.
	const un = makeLifecycle();
	await un.lifecycle.unquarantine('workspace-1', 'cluster-app-1');
	assert.deepEqual(un.sets.map((s) => s.state), ['RUNNING']);
	assert.ok(un.unsets.some((u) => 'quarantinedAt' in u));
	assert.match(un.paths[0], /\/start$/);
});

test('H2: re-revoking an already-QUARANTINED app is a no-op (grace clock preserved)', async () => {
	const already: MasterApp = {
		...mcpApp,
		kind: 'mcp-v3',
		state: 'QUARANTINED',
		quarantinedAt: new Date('2026-08-01T00:00:00Z'),
		replicas: [{ replicaId: 'r', nodeId: 'node-1', containerId: 'c', state: 'stopped' }],
	} as MasterApp;
	let writes = 0;
	let stops = 0;
	const lifecycle = new AppLifecycleService({
		repositories: {
			apps: { findOne: async () => already, updateOne: async () => { writes += 1; return { modifiedCount: 1 }; } },
			nodes: { find: () => ({ toArray: async () => [{ nodeId: 'node-1', address: 'https://n1' }] }) },
			lifecycleEvents: { insertMany: async () => undefined },
		} as never,
		agentClient: { request: async () => { stops += 1; return { status: 200, body: {} }; } } as never,
		ingress: { remove: async () => undefined } as never,
	});
	await lifecycle.remove('workspace-1', 'cluster-app-1', { workspaceRevoked: true });
	assert.equal(writes, 0); // no re-stamp of quarantinedAt
	assert.equal(stops, 0); // no re-stop
});
