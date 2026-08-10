import assert from 'node:assert/strict';
import test from 'node:test';

import { masterErrorResponse } from './master-server.js';

test('a Mongo error survives the error handler and reports its own cause', () => {
	// Mongo's `code` is a number. Reading it as a string used to throw inside the handler, so the
	// Hub received a 500 carrying that TypeError and had nothing to map — which is how a
	// duplicate-key collision surfaced to an operator as an unexplained AUTO_FINALIZATION_FAILED.
	const duplicateKey = Object.assign(
		new Error('E11000 duplicate key error collection: privos_registration.apps_master_apps index: appId_1'),
		{ code: 11000 },
	);

	const response = masterErrorResponse(duplicateKey);

	assert.equal(response.statusCode, 500);
	assert.match(response.body.message, /E11000 duplicate key/);
	assert.match(response.body.error, /E11000 duplicate key/);
});

test('tagged capacity errors still map to 409', () => {
	for (const code of ['WORKSPACE_QUOTA_EXCEEDED', 'NODE_CAPACITY_EXHAUSTED', 'HA_REQUIRES_STATELESS_APP']) {
		const response = masterErrorResponse(Object.assign(new Error('nope'), { code }));
		assert.equal(response.statusCode, 409, code);
		assert.equal(response.body.error, code);
	}
});

test('an explicit statusCode wins, and an untagged error is a 500 carrying its message', () => {
	assert.equal(masterErrorResponse(Object.assign(new Error('bad input'), { statusCode: 400 })).statusCode, 400);

	const plain = masterErrorResponse(new Error('something broke'));
	assert.equal(plain.statusCode, 500);
	assert.equal(plain.body.error, 'something broke');
});

test('a value with no message at all still produces a usable body', () => {
	const response = masterErrorResponse({});
	assert.equal(response.statusCode, 500);
	assert.equal(response.body.error, 'internal error');
	assert.equal(response.body.message, 'internal error');
});
