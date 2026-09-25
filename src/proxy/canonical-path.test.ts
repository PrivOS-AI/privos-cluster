import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalizePath, matchLongestPrefix } from './canonical-path.js';

test('canonicalizePath accepts an ordinary path and preserves the query', () => {
	assert.deepEqual(canonicalizePath('/api/v1/things?x=1'), { pathname: '/api/v1/things', search: '?x=1' });
	assert.deepEqual(canonicalizePath('/'), { pathname: '/', search: '' });
});

test('canonicalizePath rejects encoded slash/backslash', () => {
	assert.equal(canonicalizePath('/api%2f..%2fsecret'), null);
	assert.equal(canonicalizePath('/api%5c..%5csecret'), null);
	assert.equal(canonicalizePath('/API%2F'), null); // case-insensitive
});

test('canonicalizePath rejects dot segments and double slash', () => {
	assert.equal(canonicalizePath('/api/../secret'), null);
	assert.equal(canonicalizePath('/./api'), null);
	assert.equal(canonicalizePath('/api//things'), null);
	assert.equal(canonicalizePath('//evil.com'), null);
});

test('canonicalizePath rejects an unparseable target', () => {
	assert.equal(canonicalizePath('ht!tp://[::'), null);
});

test('matchLongestPrefix picks the most specific match on a segment boundary', () => {
	const routes = [
		{ prefix: '/', value: 'root' },
		{ prefix: '/api', value: 'api' },
		{ prefix: '/api/v1', value: 'api-v1' },
	];
	assert.equal(matchLongestPrefix('/api/v1/things', routes), 'api-v1');
	assert.equal(matchLongestPrefix('/api/other', routes), 'api');
	assert.equal(matchLongestPrefix('/ui', routes), 'root');
	assert.equal(matchLongestPrefix('/apikeys', routes), 'root', 'segment boundary — /api must not match /apikeys');
});

test('matchLongestPrefix returns undefined when nothing matches', () => {
	assert.equal(matchLongestPrefix('/x', [{ prefix: '/api', value: 'api' }]), undefined);
});
