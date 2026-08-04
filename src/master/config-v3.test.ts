import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { loadMasterConfig } from './config.js';

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		MASTER_MONGODB_URL: 'mongodb://localhost:27017',
		APP_MASTER_SERVICE_KEY: 's'.repeat(32),
		APP_MASTER_KEY_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64'),
		...overrides,
	};
}

test('v3 install remains off by default and requires an explicit public release trust set when enabled', () => {
	assert.equal(loadMasterConfig(environment()).APP_CLUSTER_MCP_INSTALL_V3, 'off');
	assert.throws(() => loadMasterConfig(environment({ APP_CLUSTER_MCP_INSTALL_V3: 'on' })), /release authority JWKS/);

	const pair = crypto.generateKeyPairSync('ed25519');
	const publicJwk = pair.publicKey.export({ format: 'jwk' });
	const enabled = loadMasterConfig(environment({
		APP_CLUSTER_MCP_INSTALL_V3: 'on',
		MCP_RELEASE_AUTHORITY_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
	}));
	assert.equal(enabled.APP_CLUSTER_MCP_INSTALL_V3, 'on');
	assert.equal(enabled.APP_CLUSTER_MCP_INSTALL_V2, 'off');
	assert.throws(() => loadMasterConfig(environment({
		APP_CLUSTER_MCP_INSTALL_V3: 'on',
		MCP_RELEASE_AUTHORITY_JWKS_JSON: JSON.stringify({ keys: [pair.privateKey.export({ format: 'jwk' })] }),
	})), /release authority JWKS/);
});
