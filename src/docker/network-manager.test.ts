import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canAttachAgentToWorkspaceNetwork } from './network-manager.js';

test('host-network fleet agent is not attached to workspace bridge', () => {
    assert.equal(canAttachAgentToWorkspaceNetwork('host'), false);
});

test('container-network namespace cannot be attached to workspace bridge', () => {
    assert.equal(canAttachAgentToWorkspaceNetwork('container:abc123'), false);
});

test('bridge-network fleet agent remains attachable', () => {
    assert.equal(canAttachAgentToWorkspaceNetwork('bridge'), true);
    assert.equal(canAttachAgentToWorkspaceNetwork('privos-agent'), true);
    assert.equal(canAttachAgentToWorkspaceNetwork(undefined), true);
});
