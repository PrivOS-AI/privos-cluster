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
import { imageRepositoryOf, resolveImmutableImageReference } from '../docker/image-reference.js';
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

test('imageRepositoryOf strips a digest pin so a redeploy can name a different image', () => {
	const pinned = `registry.example/marketplace/app@sha256:${'a'.repeat(64)}`;
	assert.equal(imageRepositoryOf(pinned), 'registry.example/marketplace/app');
	// Unpinned references pass through untouched.
	assert.equal(imageRepositoryOf('registry.example/marketplace/app'), 'registry.example/marketplace/app');
	// A port in the registry host must survive — this project has already shipped
	// one defect where the port was lost while rewriting an image reference.
	assert.equal(imageRepositoryOf(`10.88.0.11:5000/marketplace/app@sha256:${'b'.repeat(64)}`), '10.88.0.11:5000/marketplace/app');
	// The result must be usable as the base for a DIFFERENT digest, which is the
	// whole reason this helper exists.
	assert.equal(
		resolveImmutableImageReference(imageRepositoryOf(pinned), 'latest', `sha256:${'c'.repeat(64)}`),
		`registry.example/marketplace/app@sha256:${'c'.repeat(64)}`,
	);
	// And passing the pinned reference verbatim is exactly what used to fail.
	assert.throws(() => resolveImmutableImageReference(pinned, 'latest', `sha256:${'c'.repeat(64)}`), /does not match the repository pin/);
});
