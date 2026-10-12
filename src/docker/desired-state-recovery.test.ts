import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { config } from '../config.js';
import { DesiredStateStore } from './desired-state.js';
import { afterRecovery, recoverDesiredState, type RecoveryDeps } from './desired-state-recovery.js';
import { NetworkManager } from './network-manager.js';

type Fake = { state?: string; oom?: boolean; labels?: Record<string, string>; mode?: string; endpoint?: string; inspectError?: number };

async function harness(
	t: import('node:test').TestContext,
	opts: { recorded?: { bootId: string; containers: Record<string, 'running' | 'stopped'> }; boot?: string; containers: Record<string, Fake>; bound?: string[]; repair?: RecoveryDeps['repairNetwork']; startFails?: string[] },
) {
	const mutable = config as { FLEET_MODE: boolean };
	const previousMode = mutable.FLEET_MODE;
	mutable.FLEET_MODE = true; // workspace network names only exist in fleet mode
	t.after(() => { mutable.FLEET_MODE = previousMode; });
	const dir = await fs.mkdtemp(path.join('/tmp', 'privos-recovery-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'state.json');
	if (opts.recorded) await fs.writeFile(file, JSON.stringify(opts.recorded));
	const store = new DesiredStateStore(() => file, () => true);
	const started: string[] = [];
	const logs: Array<{ level: string; obj: object; msg: string }> = [];
	const log = (level: string) => (obj: object, msg: string) => { logs.push({ level, obj, msg }); };
	const deps: RecoveryDeps = {
		store,
		readBootId: async () => opts.boot ?? 'boot-new',
		listManaged: async () => Object.entries(opts.containers).map(([Id, c]) => ({ Id, State: c.state ?? 'exited' })),
		inspect: async (id) => {
			const c = opts.containers[id];
			if (!c || c.inspectError) throw Object.assign(new Error('gone'), { statusCode: c?.inspectError ?? 404 });
			return {
				State: { Running: c.state === 'running', OOMKilled: c.oom ?? false },
				Config: { Labels: c.labels ?? { 'privos.workspace': 'ws-1' } },
				HostConfig: { NetworkMode: c.mode ?? 'privos-ws-ws-1-apps' },
				NetworkSettings: { Networks: { [c.mode ?? 'privos-ws-ws-1-apps']: { NetworkID: c.endpoint ?? 'net-1' } } },
			};
		},
		start: async (id) => {
			if (opts.startFails?.includes(id)) throw new Error('boom');
			started.push(id);
		},
		repairNetwork: opts.repair ?? (async () => false),
		isBound: (replicaId) => opts.bound?.includes(replicaId) ?? false,
		log: { info: log('info'), warn: log('warn'), error: log('error') },
	};
	return { deps, store, started, logs, file };
}

const NEW = { bootId: 'boot-old' };

test('same boot id only seeds running containers and starts nothing', async (t) => {
	const h = await harness(t, {
		boot: 'boot-old',
		recorded: { ...NEW, containers: { dead: 'running' } },
		containers: { dead: {}, live: { state: 'running' } },
	});
	const summary = await recoverDesiredState(h.deps);
	assert.equal(summary.mode, 'seeded');
	assert.deepEqual(h.started, []);
	assert.equal(await h.store.get('live'), 'running');
});

test('a missing record (first start of this release) seeds only', async (t) => {
	const h = await harness(t, { containers: { dead: {}, live: { state: 'running' } } });
	const summary = await recoverDesiredState(h.deps);
	assert.equal(summary.mode, 'seeded');
	assert.deepEqual(h.started, []);
	assert.deepEqual((await h.store.read())?.containers, { live: 'running' });
	assert.equal((await h.store.read())?.bootId, 'boot-new');
});

test('a new boot id starts only containers recorded running, then stamps the boot', async (t) => {
	const h = await harness(t, {
		recorded: { ...NEW, containers: { a: 'running', b: 'stopped', c: 'running' } },
		containers: { a: {}, b: {}, c: {}, unknown: {} },
	});
	const summary = await recoverDesiredState(h.deps);
	assert.deepEqual(h.started.sort(), ['a', 'c']);
	assert.equal(summary.started, 2);
	assert.equal((await h.store.read())?.bootId, 'boot-new');
});

test('skip reasons: stopped on re-read, OOM, broker unbound, network mismatch, already running, gone', async (t) => {
	const mcp = (replica: string) => ({ 'privos.workspace': 'ws-1', 'privos.mcp.schema': '3', 'privos.mcp.replica': replica });
	const h = await harness(t, {
		recorded: { ...NEW, containers: { oom: 'running', unbound: 'running', bound: 'running', v2: 'running', mismatch: 'running', up: 'running', gone: 'running' } },
		containers: {
			oom: { oom: true },
			unbound: { labels: mcp('r-unbound') },
			bound: { labels: mcp('r-bound') },
			v2: { labels: { ...mcp('r-v2'), 'privos.mcp.schema': '2' } },
			mismatch: { mode: 'privos-ws-other-apps' },
			up: { state: 'running' },
		},
		bound: ['r-bound'],
	});
	const summary = await recoverDesiredState(h.deps);
	assert.deepEqual(h.started, ['bound']);
	assert.deepEqual(summary.skipped, { oomKilled: 1, brokerUnbound: 2, networkMismatch: 1, alreadyRunning: 1, gone: 1 });
	assert.equal(h.logs.some((l) => l.level === 'warn' && l.msg.includes('OOM')), true);
	assert.equal(await h.store.get('gone'), undefined);
});

test('a container stopped while recovery runs is skipped on re-read', async (t) => {
	const h = await harness(t, {
		recorded: { ...NEW, containers: { a: 'running' } },
		containers: { a: {} },
	});
	// An operator stop lands after the file was read but before the container is reached.
	const list = h.deps.listManaged;
	h.deps.listManaged = async () => { await h.store.mark('a', 'stopped'); return list(); };
	const summary = await recoverDesiredState(h.deps);
	assert.deepEqual(h.started, []);
	assert.equal(summary.skipped.stoppedOnReread, 1);
});

test('one failing container does not block the others', async (t) => {
	const h = await harness(t, {
		recorded: { ...NEW, containers: { a: 'running', b: 'running', c: 'running' } },
		containers: { a: {}, b: {}, c: {} },
		startFails: ['b'],
	});
	const summary = await recoverDesiredState(h.deps);
	assert.deepEqual(h.started.sort(), ['a', 'c']);
	assert.equal(summary.failed, 1);
	assert.equal(h.logs.filter((l) => l.level === 'error').length, 1);
});

test('at most four containers are recovered at once', async (t) => {
	const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
	const h = await harness(t, {
		recorded: { ...NEW, containers: Object.fromEntries(ids.map((id) => [id, 'running' as const])) },
		containers: Object.fromEntries(ids.map((id) => [id, {}])),
	});
	let active = 0;
	let peak = 0;
	h.deps.start = async () => {
		active += 1;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active -= 1;
	};
	await recoverDesiredState(h.deps);
	assert.equal(peak, 4);
});

test('the network is repaired with the workspace id and the endpoint network id before start', async (t) => {
	const order: string[] = [];
	const h = await harness(t, {
		recorded: { ...NEW, containers: { a: 'running' } },
		containers: { a: { endpoint: 'old-net' } },
		repair: async (id, name, ws, endpoint) => {
			order.push(`repair ${id} ${name} ${ws} ${endpoint}`);
			return true;
		},
	});
	const start = h.deps.start;
	h.deps.start = async (id) => { order.push('start'); return start(id); };
	await recoverDesiredState(h.deps);
	assert.deepEqual(order, ['repair a privos-ws-ws-1-apps ws-1 old-net', 'start']);
});

test('recovery never throws and does nothing outside an enabled store', async (t) => {
	const h = await harness(t, { containers: {} });
	h.deps.readBootId = async () => { throw new Error('no boot id'); };
	await assert.doesNotReject(recoverDesiredState(h.deps));
	assert.equal(h.logs.some((l) => l.level === 'error'), true);
	const off = new DesiredStateStore(() => '/nonexistent/x.json', () => false);
	assert.equal((await recoverDesiredState({ ...h.deps, store: off })).mode, 'unavailable');
});

test('the network sweep waits for recovery to finish', async () => {
	const order: string[] = [];
	let release!: () => void;
	const recovery = new Promise<void>((resolve) => { release = resolve; }).then(() => { order.push('recovery done'); });
	const sweep = afterRecovery(recovery, async () => { order.push('sweep'); });
	const pending = sweep();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(order, []);
	release();
	await pending;
	assert.deepEqual(order, ['recovery done', 'sweep']);
});

// --- NetworkManager.repairContainerNetwork -----------------------------------

function fakeNetworkDocker(state: { exists: boolean; id: string }, calls: string[]) {
	return {
		createNetwork: async () => { state.exists = true; state.id = 'new-net'; calls.push('create'); },
		getContainer: () => ({ inspect: async () => ({ HostConfig: { NetworkMode: 'host' } }) }),
		getNetwork: () => ({
			inspect: async () => {
				if (!state.exists) throw Object.assign(new Error('nf'), { statusCode: 404 });
				return { Id: state.id, Containers: {} };
			},
			disconnect: async () => { calls.push('disconnect'); },
			connect: async () => { calls.push('connect'); },
		}),
	} as never;
}

test('a missing network is recreated and the stale endpoint reconnected', async () => {
	const mutable = config as { FLEET_MODE: boolean };
	const previous = mutable.FLEET_MODE;
	mutable.FLEET_MODE = true;
	try {
		const calls: string[] = [];
		const manager = new NetworkManager(fakeNetworkDocker({ exists: false, id: '' }, calls));
		assert.equal(await manager.repairContainerNetwork('c1', 'privos-ws-ws-1-apps', 'ws-1', 'old-net'), true);
		assert.deepEqual(calls, ['create', 'disconnect', 'connect']);

		const intact: string[] = [];
		const ok = new NetworkManager(fakeNetworkDocker({ exists: true, id: 'same' }, intact));
		assert.equal(await ok.repairContainerNetwork('c1', 'privos-ws-ws-1-apps', 'ws-1', 'same'), false);
		assert.deepEqual(intact, []);
	} finally {
		mutable.FLEET_MODE = previous;
	}
});
