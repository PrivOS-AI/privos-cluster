import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canAttachAgentToWorkspaceNetwork, NetworkManager } from './network-manager.js';
import { config } from '../config.js';

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

type FakeNetwork = {
    containers: Record<string, { Name: string }>;
    removed: boolean;
    disconnected: string[];
    inspectError?: { statusCode: number };
    removeError?: { statusCode: number };
};

function fakeDocker(networks: Record<string, FakeNetwork>, summaries: Array<{ Name: string; Created?: string }> = []) {
    return {
        listNetworks: async () => summaries,
        getNetwork: (name: string) => ({
            inspect: async () => {
                const network = networks[name];
                if (!network) throw Object.assign(new Error('not found'), { statusCode: 404 });
                if (network.inspectError) throw Object.assign(new Error('inspect failed'), network.inspectError);
                return { Containers: network.containers };
            },
            disconnect: async (options: { Container: string }) => {
                networks[name]!.disconnected.push(options.Container);
            },
            remove: async () => {
                const network = networks[name]!;
                if (network.removeError) throw Object.assign(new Error('remove failed'), network.removeError);
                network.removed = true;
            },
        }),
    } as never;
}

function withFleetMode<T>(work: () => Promise<T>): Promise<T> {
    const previous = config.FLEET_MODE;
    (config as { FLEET_MODE: boolean }).FLEET_MODE = true;
    return work().finally(() => {
        (config as { FLEET_MODE: boolean }).FLEET_MODE = previous;
    });
}

test('an empty workspace network is removed and its subnet reclaimed', async () => {
    await withFleetMode(async () => {
        const networks: Record<string, FakeNetwork> = {
            'privos-ws-ws-1-apps': { containers: {}, removed: false, disconnected: [] },
        };
        const manager = new NetworkManager(fakeDocker(networks));
        assert.equal(await manager.removeWorkspaceNetworkIfUnused('ws-1'), true);
        assert.equal(networks['privos-ws-ws-1-apps']!.removed, true);
    });
});

test('a workspace network with a live container is kept', async () => {
    await withFleetMode(async () => {
        const networks: Record<string, FakeNetwork> = {
            'privos-ws-ws-1-apps': { containers: { c1: { Name: 'app-container' } }, removed: false, disconnected: [] },
        };
        const manager = new NetworkManager(fakeDocker(networks));
        assert.equal(await manager.removeWorkspaceNetworkIfUnused('ws-1'), false);
        assert.equal(networks['privos-ws-ws-1-apps']!.removed, false);
    });
});

test('an agent-only attachment is disconnected before removal', async () => {
    await withFleetMode(async () => {
        const networks: Record<string, FakeNetwork> = {
            'privos-ws-ws-1-apps': {
                containers: { a: { Name: config.FLEET_AGENT_CONTAINER } },
                removed: false,
                disconnected: [],
            },
        };
        const manager = new NetworkManager(fakeDocker(networks));
        assert.equal(await manager.removeWorkspaceNetworkIfUnused('ws-1'), true);
        assert.deepEqual(networks['privos-ws-ws-1-apps']!.disconnected, [config.FLEET_AGENT_CONTAINER]);
        assert.equal(networks['privos-ws-ws-1-apps']!.removed, true);
    });
});

test('a missing network and a lost removal race both report "kept"', async () => {
    await withFleetMode(async () => {
        const networks: Record<string, FakeNetwork> = {
            'privos-ws-ws-2-apps': { containers: {}, removed: false, disconnected: [], removeError: { statusCode: 409 } },
        };
        const manager = new NetworkManager(fakeDocker(networks));
        assert.equal(await manager.removeWorkspaceNetworkIfUnused('ws-1'), false);
        assert.equal(await manager.removeWorkspaceNetworkIfUnused('ws-2'), false);
    });
});

test('the sweep removes only old, empty workspace app networks', async () => {
    await withFleetMode(async () => {
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const young = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const networks: Record<string, FakeNetwork> = {
            'privos-ws-ws-old-apps': { containers: {}, removed: false, disconnected: [] },
            'privos-ws-ws-young-apps': { containers: {}, removed: false, disconnected: [] },
            'privos-ws-ws-busy-apps': { containers: { c: { Name: 'app' } }, removed: false, disconnected: [] },
        };
        const manager = new NetworkManager(fakeDocker(networks, [
            { Name: 'privos-ws-ws-old-apps', Created: old },
            { Name: 'privos-ws-ws-young-apps', Created: young },
            { Name: 'privos-ws-ws-busy-apps', Created: old },
            { Name: 'demo-privos-net', Created: old },
            { Name: 'bridge', Created: old },
        ]));
        const removed = await manager.sweepUnusedWorkspaceNetworks(60 * 60 * 1000);
        assert.deepEqual(removed, ['privos-ws-ws-old-apps']);
        assert.equal(networks['privos-ws-ws-young-apps']!.removed, false);
        assert.equal(networks['privos-ws-ws-busy-apps']!.removed, false);
    });
});

test('the garbage collector is inert outside fleet mode', async () => {
    const networks: Record<string, FakeNetwork> = {
        'privos-ws-ws-1-apps': { containers: {}, removed: false, disconnected: [] },
    };
    const manager = new NetworkManager(fakeDocker(networks, [{ Name: 'privos-ws-ws-1-apps' }]));
    assert.equal(await manager.removeWorkspaceNetworkIfUnused('ws-1'), false);
    assert.deepEqual(await manager.sweepUnusedWorkspaceNetworks(0), []);
    assert.equal(networks['privos-ws-ws-1-apps']!.removed, false);
});
