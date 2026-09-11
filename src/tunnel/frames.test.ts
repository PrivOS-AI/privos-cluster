import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	FRAME_VERSION,
	MAX_CHUNK_BYTES,
	MAX_JSON_FRAME_BYTES,
	MAX_STAGED_ARTIFACT_BYTES,
	FrameDecodeError,
	FrameEncodeError,
	decodeFrame,
	encodeFrame,
	type Frame,
} from './frames.js';
// Vendored copy of the phase-1 normative contract
// (plans/260911-1857-.../artifacts/tunnel-frame-vectors.json). Both mirrors
// (this module and the Hub's app-cluster-tunnel-frames.ts) round-trip the
// same source vectors; a drift here is a failing test, not a field incident.
import vectorFile from './tunnel-frame-vectors.json' with { type: 'json' };

interface Vector {
	name: string;
	decoded: Frame;
	encoded: string;
}

const vectors = vectorFile.vectors as Vector[];

test('vector file frameVersion matches the codec FRAME_VERSION', () => {
	assert.equal(vectorFile.frameVersion, FRAME_VERSION);
});

test('every shared vector round-trips: decode(encoded) equals decoded', () => {
	for (const vector of vectors) {
		assert.deepEqual(decodeFrame(vector.encoded), vector.decoded, `decode mismatch for vector '${vector.name}'`);
	}
});

test('every shared vector round-trips: encode(decoded) parses back to an equivalent JSON value', () => {
	for (const vector of vectors) {
		const reEncoded = encodeFrame(vector.decoded);
		assert.deepEqual(JSON.parse(reEncoded), JSON.parse(vector.encoded), `encode mismatch for vector '${vector.name}'`);
	}
});

test('decodeFrame rejects malformed JSON with FrameDecodeError closeCode 4400', () => {
	assert.throws(() => decodeFrame('{not json'), (err: unknown) => {
		assert.ok(err instanceof FrameDecodeError);
		assert.equal(err.closeCode, 4400);
		return true;
	});
});

test('decodeFrame rejects an unknown frame type', () => {
	assert.throws(() => decodeFrame(JSON.stringify({ t: 'not-a-frame' })), FrameDecodeError);
});

test('decodeFrame rejects a frame missing a required field', () => {
	assert.throws(() => decodeFrame(JSON.stringify({ t: 'hello', version: '1.0.0' })), FrameDecodeError);
});

test('decodeFrame rejects a JSON frame over the 1 MB cap', () => {
	const oversized = JSON.stringify({ t: 'ping', at: 1, pad: 'x'.repeat(MAX_JSON_FRAME_BYTES) });
	assert.throws(() => decodeFrame(oversized), FrameDecodeError);
});

test('encodeFrame rejects a frame that would exceed the 1 MB cap', () => {
	const huge = { t: 'res', id: 'x', status: 200, body: { pad: 'x'.repeat(MAX_JSON_FRAME_BYTES) } } as unknown as Frame;
	assert.throws(() => encodeFrame(huge), FrameEncodeError);
});

test('cap constants match the frozen wire contract', () => {
	assert.equal(MAX_JSON_FRAME_BYTES, 1_000_000);
	assert.equal(MAX_CHUNK_BYTES, 1024 * 1024);
	assert.equal(MAX_STAGED_ARTIFACT_BYTES, 250_000_000);
});
