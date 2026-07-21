import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeHealthTransition, revertFailedRestart } from './health-monitor.js';
import type { HealthCheck } from '../types/index.js';

function baseline(overrides: Partial<HealthCheck> = {}): HealthCheck {
	return { status: 'unknown', failCount: 0, restartCount: 0, lastCheck: null, ...overrides };
}

test('healthy probe resets failCount and marks status healthy', () => {
	const current = baseline({ failCount: 2, restartCount: 1 });
	const { next, shouldRestart } = computeHealthTransition(current, true, { maxFails: 3, restart: true }, 1_000);
	assert.deepEqual(next, { status: 'healthy', failCount: 0, restartCount: 1, lastCheck: 1_000 });
	assert.equal(shouldRestart, false);
});

test('unhealthy probe increments failCount below threshold, no restart', () => {
	const current = baseline({ failCount: 0 });
	const { next, shouldRestart } = computeHealthTransition(current, false, { maxFails: 3, restart: true }, 1_000);
	assert.deepEqual(next, { status: 'unhealthy', failCount: 1, restartCount: 0, lastCheck: 1_000 });
	assert.equal(shouldRestart, false);
});

test('reaching maxFails with restart=true triggers restart and resets failCount/increments restartCount', () => {
	const current = baseline({ failCount: 2, restartCount: 0 }); // one more failure hits maxFails=3
	const { next, shouldRestart } = computeHealthTransition(current, false, { maxFails: 3, restart: true }, 1_000);
	assert.equal(shouldRestart, true);
	assert.deepEqual(next, { status: 'unknown', failCount: 0, restartCount: 1, lastCheck: 1_000 });
});

test('reaching maxFails with restart=false does NOT trigger restart and keeps incrementing failCount', () => {
	const current = baseline({ failCount: 2, restartCount: 0 });
	const { next, shouldRestart } = computeHealthTransition(current, false, { maxFails: 3, restart: false }, 1_000);
	assert.equal(shouldRestart, false);
	assert.deepEqual(next, { status: 'unhealthy', failCount: 3, restartCount: 0, lastCheck: 1_000 });

	// Further failures keep accumulating — never restarts.
	const { next: next2, shouldRestart: shouldRestart2 } = computeHealthTransition(next, false, { maxFails: 3, restart: false }, 2_000);
	assert.equal(shouldRestart2, false);
	assert.deepEqual(next2, { status: 'unhealthy', failCount: 4, restartCount: 0, lastCheck: 2_000 });
});

test('counters reset after a restart once the container reports healthy again', () => {
	// Simulates the state right after a successful auto-restart.
	const postRestart = baseline({ status: 'unknown', failCount: 0, restartCount: 1 });
	const { next, shouldRestart } = computeHealthTransition(postRestart, true, { maxFails: 3, restart: true }, 3_000);
	assert.equal(shouldRestart, false);
	assert.deepEqual(next, { status: 'healthy', failCount: 0, restartCount: 1, lastCheck: 3_000 });
});

test('revertFailedRestart marks unhealthy at maxFails without losing the restart attempt count', () => {
	const afterOptimisticRestart: HealthCheck = { status: 'unknown', failCount: 0, restartCount: 1, lastCheck: 1_000 };
	const reverted = revertFailedRestart(afterOptimisticRestart, { maxFails: 3 }, 2_000);
	assert.deepEqual(reverted, { status: 'unhealthy', failCount: 3, restartCount: 1, lastCheck: 2_000 });
});
