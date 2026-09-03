import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { ContainerManager } from './container-manager.js';

/** Fake hijacked exec stream: an EventEmitter that records destroy() and never ends. */
function fakeDockerWith(stream: EventEmitter & { destroy: () => void }): any {
	const exec = { start: async () => stream };
	return { getContainer: () => ({ exec: async () => exec }) };
}

function makeStream(): EventEmitter & { destroy: () => void; destroyed: number } {
	const s = new EventEmitter() as EventEmitter & { destroy: () => void; destroyed: number };
	s.destroyed = 0;
	s.destroy = () => {
		s.destroyed += 1;
	};
	return s;
}

test('execCommand rejects and destroys the stream when the exec never ends (timeout)', async () => {
	const stream = makeStream();
	const cm = new ContainerManager(fakeDockerWith(stream) as any);
	await assert.rejects(cm.execCommand('c1', ['sleep', '999'], { timeoutMs: 20 }), /timed out/);
	assert.equal(stream.destroyed, 1);
});

test('execCommand rejects and destroys the stream when output exceeds the byte cap', async () => {
	const stream = makeStream();
	const cm = new ContainerManager(fakeDockerWith(stream) as any);
	const p = cm.execCommand('c1', ['cat', 'big'], { maxBytes: 4, timeoutMs: 5000 });
	setImmediate(() => stream.emit('data', Buffer.from('123456789')));
	await assert.rejects(p, /exceeded/);
	assert.equal(stream.destroyed, 1);
});

test('execCommand resolves normally on a clean end and still destroys the stream', async () => {
	const stream = makeStream();
	const cm = new ContainerManager(fakeDockerWith(stream) as any);
	const p = cm.execCommand('c1', ['echo', 'hi'], { timeoutMs: 5000 });
	setImmediate(() => {
		stream.emit('data', Buffer.from('hi\r\n'));
		stream.emit('end');
	});
	assert.equal(await p, 'hi\n'); // carriage returns stripped
	assert.equal(stream.destroyed, 1);
});
