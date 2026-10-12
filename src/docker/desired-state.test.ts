import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { config } from '../config.js';
import { ContainerManager } from './container-manager.js';
import { DesiredStateStore } from './desired-state.js';

async function tempFile(t: import('node:test').TestContext): Promise<string> {
	const dir = await fs.mkdtemp(path.join('/tmp', 'privos-desired-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	return path.join(dir, 'sub', 'state.json');
}

const store = (file: string, enabled = true) => new DesiredStateStore(() => file, () => enabled);

test('mark, remove and seed produce the expected file', async (t) => {
	const file = await tempFile(t);
	const s = store(file);
	await s.mark('a', 'running');
	await s.mark('b', 'stopped');
	await s.remove('b');
	await s.seedAndStamp(['a', 'c'], 'boot-1');
	assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { bootId: 'boot-1', containers: { a: 'running', c: 'running' } });
	assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
	await s.seedAndStamp([], 'boot-1');
	assert.equal(await s.get('a'), 'running');
});

test('seed never overrides an explicit stopped record', async (t) => {
	const s = store(await tempFile(t));
	await s.mark('a', 'stopped');
	await s.seedAndStamp(['a'], 'boot-1');
	assert.equal(await s.get('a'), 'stopped');
});

test('concurrent writes are serialized and none is lost', async (t) => {
	const file = await tempFile(t);
	const s = store(file);
	await Promise.all(Array.from({ length: 25 }, (_, i) => s.mark(`c${i}`, 'running')));
	assert.equal(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).containers).length, 25);
});

test('a corrupt file is moved aside and treated as absent', async (t) => {
	const file = await tempFile(t);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, '{nope');
	const s = store(file);
	assert.equal(await s.read(), null);
	const siblings = await fs.readdir(path.dirname(file));
	assert.equal(siblings.some((name) => name.startsWith('state.json.corrupt-')), true);
	assert.equal(siblings.includes('state.json'), false);
	await s.mark('a', 'running');
	assert.equal(await s.get('a'), 'running');
});

test('a failed write does not throw', async (t) => {
	const file = await tempFile(t);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.mkdir(file); // the state path is a directory: every read and write fails
	const s = store(file);
	await assert.doesNotReject(s.mark('a', 'running'));
	await assert.doesNotReject(s.remove('a'));
	assert.equal(await s.read(), null);
});

test('outside fleet mode the store does nothing', async (t) => {
	const file = await tempFile(t);
	const s = store(file, false);
	await s.mark('a', 'running');
	assert.equal(await s.read(), null);
	await assert.rejects(fs.stat(path.dirname(file)));
});

// --- container-manager hooks -------------------------------------------------

type Call = string;
function fakeDockerFor(calls: Call[], opts: { startStatus?: number } = {}) {
	return {
		createContainer: async () => ({ inspect: async () => ({ Id: 'cid' }) }),
		getContainer: (id: string) => ({
			start: async () => {
				calls.push(`docker.start ${id}`);
				if (opts.startStatus) throw Object.assign(new Error('x'), { statusCode: opts.startStatus });
			},
			stop: async () => { calls.push(`docker.stop ${id}`); },
			restart: async () => { calls.push(`docker.restart ${id}`); },
			remove: async () => { calls.push(`docker.remove ${id}`); },
		}),
	} as never;
}

async function withFleetState<T>(t: import('node:test').TestContext, work: (file: string) => Promise<T>): Promise<T> {
	const file = await tempFile(t);
	const mutable = config as { FLEET_MODE: boolean; AGENT_DESIRED_STATE_PATH: string };
	const previous = { mode: mutable.FLEET_MODE, path: mutable.AGENT_DESIRED_STATE_PATH };
	mutable.FLEET_MODE = true;
	mutable.AGENT_DESIRED_STATE_PATH = file;
	try {
		return await work(file);
	} finally {
		mutable.FLEET_MODE = previous.mode;
		mutable.AGENT_DESIRED_STATE_PATH = previous.path;
	}
}

const readState = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8')).containers;

test('lifecycle methods record create, start (also 304), stop-before-docker and remove; restart writes nothing', async (t) => {
	await withFleetState(t, async (file) => {
		const calls: Call[] = [];
		const manager = new ContainerManager(fakeDockerFor(calls));
		const created = await manager.createAppContainer({
			id: 'x', appId: 'a', workspaceId: 'ws-1', containerName: 'n', image: 'img', tag: 'latest', port: 1,
			resources: { memoryMb: 64, cpus: 0.1, tmpSizeMb: 8 }, securityProfile: null,
		});
		assert.equal((await readState(file))[created.containerId], 'running');

		// The stop is recorded while Docker has not been asked yet.
		const stopManager = new ContainerManager({
			getContainer: () => ({
				stop: async () => { calls.push(`stopping saw ${(await readState(file)).s}`); },
			}),
		} as never);
		await stopManager.stopContainer('s');
		assert.deepEqual(calls.at(-1), 'stopping saw stopped');

		await manager.startContainer('s');
		assert.equal((await readState(file)).s, 'running');
		await manager.stopContainer('s');
		const before = await fs.readFile(file, 'utf8');
		await manager.restartContainer('s');
		assert.equal(await fs.readFile(file, 'utf8'), before);
		assert.equal((await readState(file)).s, 'stopped');

		const already = new ContainerManager(fakeDockerFor(calls, { startStatus: 304 }));
		await already.startContainer('s');
		assert.equal((await readState(file)).s, 'running');

		await manager.removeContainer('s', true);
		assert.equal('s' in (await readState(file)), false);
	});
});

test('a failed start does not record running', async (t) => {
	await withFleetState(t, async (file) => {
		const manager = new ContainerManager(fakeDockerFor([], { startStatus: 500 }));
		await assert.rejects(manager.startContainer('z'));
		await assert.rejects(fs.stat(file));
	});
});

test('lifecycle calls still succeed when the record cannot be written', async (t) => {
	await withFleetState(t, async (file) => {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.mkdir(file);
		const manager = new ContainerManager(fakeDockerFor([]));
		await assert.doesNotReject(manager.startContainer('s'));
		await assert.doesNotReject(manager.stopContainer('s'));
		await assert.doesNotReject(manager.removeContainer('s'));
	});
});

test('outside fleet mode lifecycle calls write no record', async (t) => {
	const file = await tempFile(t);
	const mutable = config as { AGENT_DESIRED_STATE_PATH: string };
	const previous = mutable.AGENT_DESIRED_STATE_PATH;
	mutable.AGENT_DESIRED_STATE_PATH = file;
	t.after(() => { mutable.AGENT_DESIRED_STATE_PATH = previous; });
	assert.equal(config.FLEET_MODE, false);
	await new ContainerManager(fakeDockerFor([])).startContainer('s');
	await assert.rejects(fs.stat(path.dirname(file)));
});
