import assert from 'node:assert/strict';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import { verifyClusterToken } from './auth.js';

const NODE_ID = 'apps-eu-01';
const NODE_KEY = 'fleet-node-key-0123456789-0123456789';

function sign(issuer: string, workspaceId?: string, kid = NODE_ID): string {
	return jwt.sign(
		{ sub: 'master', workspaceId },
		NODE_KEY,
		{ algorithm: 'HS256', issuer, expiresIn: '5m', keyid: kid },
	);
}

test('fleet auth accepts only the master issuer, node kid and workspace claim', () => {
	const auth = verifyClusterToken(sign('privos-apps-master', 'ws-a'), {
		fleetMode: true,
		secret: NODE_KEY,
		nodeId: NODE_ID,
	});
	assert.equal(auth.workspaceId, 'ws-a');
	assert.equal(auth.kid, NODE_ID);

	assert.throws(
		() => verifyClusterToken(sign('privos-chat', 'ws-a'), {
			fleetMode: true,
			secret: NODE_KEY,
			nodeId: NODE_ID,
		}),
		/issuer/i,
	);
	assert.throws(
		() => verifyClusterToken(sign('privos-apps-master', 'ws-a', 'apps-eu-02'), {
			fleetMode: true,
			secret: NODE_KEY,
			nodeId: NODE_ID,
		}),
		/kid/i,
	);
	assert.throws(
		() => verifyClusterToken(sign('privos-apps-master'), {
			fleetMode: true,
			secret: NODE_KEY,
			nodeId: NODE_ID,
		}),
		/workspaceId/i,
	);
});

test('non-fleet auth remains compatible with privos-chat tokens', () => {
	const token = jwt.sign(
		{ sub: 'hub-admin' },
		'legacy-cluster-secret-0123456789',
		{ algorithm: 'HS256', issuer: 'privos-chat', expiresIn: '5m' },
	);
	const auth = verifyClusterToken(token, {
		fleetMode: false,
		secret: 'legacy-cluster-secret-0123456789',
	});
	assert.equal(auth.iss, 'privos-chat');
	assert.equal(auth.sub, 'hub-admin');
});
