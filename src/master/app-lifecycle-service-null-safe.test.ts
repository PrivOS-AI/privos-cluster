/**
 * A + E + E2: `AppLifecycleService` null-safety and its D-registry/F-publisher
 * wiring — a host-less v3 app's `view()` never dereferences an absent
 * `uiUrl`, its removal skips the CNAME it never had, and workspace power
 * drives the registry's WS_SUSPENDED state alongside the container stop.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AppLifecycleService } from './app-lifecycle-service.js';
import type { MasterApp } from './types.js';

function hostLessApp(overrides: Partial<MasterApp> = {}): MasterApp {
	const now = new Date();
	return {
		appId: 'cluster-app-1', workspaceId: 'workspace-1', listingId: 'listing-1',
		versionDigest: 'sha256:version', image: 'registry.internal/example@sha256:image', imageDigest: 'sha256:image',
		resources: { memoryMb: 256, cpus: 0.25, tmpSizeMb: 64 }, port: 3000, envVars: {}, volumes: [],
		storageBytes: 0, availabilityTier: 'single', stateless: true,
		// No subdomain/uiUrl at all — the MCP_V3_NO_DEFAULT_HOST case.
		replicas: [], state: 'RUNNING', createdAt: now, updatedAt: now,
		kind: 'mcp-v3', protocolVersion: 3, mcpGenerationId: 'generation-1',
		...overrides,
	};
}

function fixture(app: MasterApp) {
	const apps = { current: app };
	const removeAllAppHostsCalls: Array<{ appId: string; generationId?: string }> = [];
	let markDirtyCalls = 0;
	let ingressRemoveCalls = 0;
	let setWorkspaceHostsSuspendedCalls: Array<{ workspaceId: string; suspended: boolean }> = [];

	const lifecycle = new AppLifecycleService({
		repositories: {
			apps: {
				findOne: async () => apps.current,
				find: () => ({ toArray: async () => [apps.current] }),
				updateOne: async (_filter: unknown, update: { $set?: Partial<MasterApp> }) => {
					if (update.$set) Object.assign(apps.current, update.$set);
					return { matchedCount: 1, modifiedCount: 1 };
				},
			},
			nodes: { find: () => ({ toArray: async () => [] }) },
			lifecycleEvents: { insertMany: async () => undefined, insertOne: async () => undefined },
		} as never,
		agentClient: { request: async () => ({ status: 200, headers: {}, body: {} }) } as never,
		ingress: {
			remove: async () => { ingressRemoveCalls += 1; },
			upsert: async () => undefined,
		} as never,
		appHosts: {
			removeAllAppHosts: async (appId: string, generationId?: string) => {
				removeAllAppHostsCalls.push({ appId, generationId });
				return 0;
			},
			setWorkspaceHostsSuspended: async (workspaceId: string, suspended: boolean) => {
				setWorkspaceHostsSuspendedCalls.push({ workspaceId, suspended });
				return 0;
			},
		} as never,
		hostTablePublisher: { markDirty: () => { markDirtyCalls += 1; } } as never,
	});
	return {
		lifecycle, apps, removeAllAppHostsCalls, get markDirtyCalls() { return markDirtyCalls; },
		get ingressRemoveCalls() { return ingressRemoveCalls; }, setWorkspaceHostsSuspendedCalls,
	};
}

test('get() on a host-less v3 app omits subdomain/domain/uiUrl entirely — never dereferences an absent uiUrl', async () => {
	const { lifecycle } = fixture(hostLessApp());
	const view = await lifecycle.get('workspace-1', 'cluster-app-1') as Record<string, unknown>;
	assert.equal('subdomain' in view, false);
	assert.equal('domain' in view, false);
	assert.equal('uiUrl' in view, false);
	assert.ok(!JSON.stringify(view).includes('undefined'));
});

test('get() on a normal app still carries subdomain/domain/uiUrl (byte-identical to before)', async () => {
	const { lifecycle } = fixture(hostLessApp({ subdomain: 'library-app', uiUrl: 'https://library-app.apps.example.com' }));
	const view = await lifecycle.get('workspace-1', 'cluster-app-1') as Record<string, unknown>;
	assert.equal(view.subdomain, 'library-app');
	assert.equal(view.domain, 'apps.example.com');
	assert.equal(view.uiUrl, 'https://library-app.apps.example.com');
});

test('remove() (destroy path) on a host-less app skips the CNAME it never had, but still tears down its D-registry hosts scoped to its generation', async () => {
	// `kind: undefined` (raw) reaches `destroy()` directly — the mcp-v3
	// signed-command guard on `remove()` is orthogonal to this null-safety
	// invariant and is covered by its own existing tests.
	const state = fixture(hostLessApp({ kind: undefined }));
	await state.lifecycle.remove('workspace-1', 'cluster-app-1', { workspaceRevoked: false });
	assert.equal(state.ingressRemoveCalls, 0);
	assert.deepEqual(state.removeAllAppHostsCalls, [{ appId: 'cluster-app-1', generationId: 'generation-1' }]);
	assert.equal(state.markDirtyCalls, 1);
});

test('remove() on a normal app removes its CNAME as before', async () => {
	const state = fixture(hostLessApp({ kind: undefined, subdomain: 'library-app', uiUrl: 'https://library-app.apps.example.com' }));
	await state.lifecycle.remove('workspace-1', 'cluster-app-1', { workspaceRevoked: false });
	assert.equal(state.ingressRemoveCalls, 1);
});

test('setWorkspacePower suspend/resume drives the D-registry\'s WS_SUSPENDED state alongside the container stop/start', async () => {
	const { lifecycle, setWorkspaceHostsSuspendedCalls } = fixture(hostLessApp());
	await lifecycle.setWorkspacePower('workspace-1', 'suspend');
	await lifecycle.setWorkspacePower('workspace-1', 'resume');
	assert.deepEqual(setWorkspaceHostsSuspendedCalls, [
		{ workspaceId: 'workspace-1', suspended: true },
		{ workspaceId: 'workspace-1', suspended: false },
	]);
});
