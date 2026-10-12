import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { listDirectoryArgv, resolveContainerPath } from './files.js';

test('resolveContainerPath keeps paths under /app and defaults to /app', () => {
	assert.equal(resolveContainerPath(undefined), '/app');
	assert.equal(resolveContainerPath(''), '/app');
	assert.equal(resolveContainerPath('/app'), '/app');
	assert.equal(resolveContainerPath('app/src'), '/app/src');
	assert.equal(resolveContainerPath('//app//src/./index.js'), '/app/src/index.js');
	assert.equal(resolveContainerPath('/app/a/../b'), '/app/b');
	// A rooted path cannot climb above /, so a leading ".." resolves to a path under /app, never outside.
	assert.equal(resolveContainerPath('../app'), '/app');
});

test('resolveContainerPath refuses anything that resolves outside /app', () => {
	for (const raw of ['/', '/etc/passwd', '/app/../etc/passwd', '/app/../../etc', '..', '/appx', '/application/x', '/app/..', '/proc/self/environ']) {
		assert.equal(resolveContainerPath(raw), null, raw);
	}
});

test('the old ".." stripping bypass no longer reaches outside /app', () => {
	// "....//" collapsed to "../" under the previous strip-and-hope sanitiser.
	assert.equal(resolveContainerPath('/app/....//....//etc/passwd'), '/app/..../..../etc/passwd');
	assert.equal(resolveContainerPath('/....//etc'), null);
});

test('listDirectoryArgv passes the path as a single argv element, never through a shell', () => {
	const hostile = '/app/$(touch /tmp/x);"`id`"';
	const argv = listDirectoryArgv(hostile);
	assert.equal(argv[0], 'find');
	assert.equal(argv[1], hostile);
	assert.ok(!argv.includes('sh'));
	assert.deepEqual(argv.slice(2), ['-maxdepth', '1', '-mindepth', '1', '-exec', 'stat', '-c', '%F|%s|%Y|%n', '{}', ';']);
});

test('files.ts spawns no shell', () => {
	const source = readFileSync(new URL('./files.ts', import.meta.url), 'utf8');
	assert.ok(!source.includes("'sh'"));
});
