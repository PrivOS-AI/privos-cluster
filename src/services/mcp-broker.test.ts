import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { NodeIdentity } from '../security/node-identity.js';
import { McpBrokerManager } from './mcp-broker.js';

test('broker keeps its host root private while making the bind-mounted replica directory traversable', async (t) => {
	const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'privos-mcp-broker-'));
	t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
	const brokerRoot = path.join(temporaryRoot, 'broker');
	const manager = new McpBrokerManager(brokerRoot, {} as NodeIdentity, async () => ({}));

	const replicaId = '11111111-1111-4111-8111-111111111111';
	const mount = await manager.prepare(replicaId);
	const rootMode = (await fs.stat(brokerRoot)).mode & 0o777;
	const mountMode = (await fs.stat(mount.source)).mode & 0o777;

	assert.equal(rootMode, 0o700);
	assert.equal(mountMode, 0o711);
	assert.equal(mount.target, '/run/privos');
});
