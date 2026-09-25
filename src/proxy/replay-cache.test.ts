import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createReplayCache } from './replay-cache.js';

test('a fresh nonce is accepted once, then rejected as a replay', () => {
	const cache = createReplayCache(60_000);
	assert.equal(cache.checkAndRemember('n1', 0), true);
	assert.equal(cache.checkAndRemember('n1', 100), false);
	assert.equal(cache.size(), 1);
});

test('a nonce is accepted again once it falls out of the TTL window', () => {
	const cache = createReplayCache(1_000);
	assert.equal(cache.checkAndRemember('n1', 0), true);
	assert.equal(cache.checkAndRemember('n1', 1_001), true, 'expired — no longer a replay');
});

test('distinct nonces never collide', () => {
	const cache = createReplayCache(60_000);
	assert.equal(cache.checkAndRemember('a', 0), true);
	assert.equal(cache.checkAndRemember('b', 0), true);
	assert.equal(cache.size(), 2);
});

test('sweeping drops expired entries so the cache never grows unbounded', () => {
	const cache = createReplayCache(1_000);
	cache.checkAndRemember('a', 0);
	cache.checkAndRemember('b', 0);
	cache.checkAndRemember('c', 2_000); // sweep runs here, dropping a/b
	assert.equal(cache.size(), 1);
});
