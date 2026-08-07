/**
 * `selectRedeploySwapStrategy` is the one place that decides rolling vs
 * stop-then-create — pulled out as a pure function specifically so this
 * decision is testable without a real Docker daemon. Every other behaviour of
 * redeployContainerSmart depends on it, so a wrong answer here is a wrong
 * answer everywhere.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { selectRedeploySwapStrategy } from './lifecycle-service.js';
import type { Container, ContainerVolume } from '../types/index.js';

function old(overrides: Partial<Pick<Container, 'volumes' | 'state'>> = {}) {
	return { volumes: [] as ContainerVolume[], state: 'running' as const, ...overrides };
}

test('a volume-free, running container defaults to rolling', () => {
	assert.equal(selectRedeploySwapStrategy(old(), {}), 'ROLLING');
});

test('a volume-backed container always takes stop-then-create', () => {
	const withVolume = old({ volumes: [{ name: 'data', mountPath: '/app/data' }] });
	assert.equal(selectRedeploySwapStrategy(withVolume, {}), 'STOP_THEN_CREATE');
});

test('a non-running container cannot take the rolling path', () => {
	assert.equal(selectRedeploySwapStrategy(old({ state: 'stopped' }), {}), 'STOP_THEN_CREATE');
});

test('the caller can opt out of rolling explicitly', () => {
	assert.equal(selectRedeploySwapStrategy(old(), { rolling: false }), 'STOP_THEN_CREATE');
});

test('an MCP v3 upgrade always takes stop-then-create, even volume-free and running', () => {
	const binding = { replicaId: '11111111-1111-4111-8111-111111111111' } as any;
	assert.equal(selectRedeploySwapStrategy(old(), { mcpV3Binding: binding }), 'STOP_THEN_CREATE');
});
