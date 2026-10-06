import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_VOLUME_LIMIT_MB, overQuotaVolumes, volumeLimitMb } from './storage-quota-monitor.js';

const MB = 1024 * 1024;

test('a volume without a declared size gets the 1 GB default quota', () => {
	assert.equal(DEFAULT_VOLUME_LIMIT_MB, 1024);
	assert.equal(volumeLimitMb({}), 1024);
	assert.equal(volumeLimitMb({ 'privos.size-mb': 'junk' }), 1024);
	assert.equal(volumeLimitMb({ 'privos.size-mb': '0' }), 1024);
	assert.equal(volumeLimitMb({ 'privos.size-mb': '4096' }), 4096);
});

test('only volumes past their quota are reported', () => {
	const over = overQuotaVolumes([
		{ name: 'at-default', bytes: 1024 * MB, labels: {} },
		{ name: 'past-default', bytes: 1024 * MB + 1, labels: {} },
		{ name: 'within-declared', bytes: 3000 * MB, labels: { 'privos.size-mb': '4096' } },
		{ name: 'past-declared', bytes: 5000 * MB, labels: { 'privos.size-mb': '4096' } },
	]);
	assert.deepEqual(over.map((volume) => [volume.name, volume.limitMb]), [['past-default', 1024], ['past-declared', 4096]]);
});
