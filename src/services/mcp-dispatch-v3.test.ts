import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson, jwkThumbprint, sha256Base64Url, signEs256Jws } from '../security/artifacts.js';
import { verifyAgentDispatchAssertionV3 } from './mcp-dispatch.js';

test('agent v3 dispatch rejects parent-only and wrong-child room work before accepting the exact child once', () => {
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const privateJwk = pair.privateKey.export({ format: 'jwk' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' });
	const kid = jwkThumbprint(publicJwk);
	const rpc = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'read' }, id: 1 };
	const labels = {
		'privos.mcp.hub-jwk': canonicalJson(publicJwk),
		'privos.mcp.hub-kid': kid,
		'privos.mcp.cluster': 'cluster-1',
		'privos.mcp.workspace': 'workspace-1',
		'privos.mcp.deployment': 'deployment-1',
		'privos.mcp.generation': 'generation-1',
		'privos.mcp.generation-number': '1',
		'privos.mcp.runtime-installation': 'runtime-1',
		'privos.mcp.app': 'mcp-app-1',
		'privos.app-id': 'cluster-app-1',
		'privos.mcp.manifest.digest': `sha256:${'f'.repeat(64)}`,
		'privos.mcp.resource-manifest-hash': 'r'.repeat(43),
		'privos.mcp.approval-receipt': 'b'.repeat(43),
		'privos.mcp.authorization-epoch': '7',
	};
	const now = Math.floor(Date.now() / 1000);
	const compact = signEs256Jws({
		privateJwk,
		kid,
		typ: 'privos-hub-dispatch+jws',
		protocolVersion: 3,
		payload: {
			protocolVersion: 3,
			type: 'hub-dispatch-assertion',
			iss: 'urn:privos:hub:deployment-1',
			aud: 'privos-mcp-app',
			jti: crypto.randomUUID(),
			nonce: crypto.randomBytes(24).toString('base64url'),
			iat: now,
			exp: now + 30,
			clusterId: 'cluster-1',
			workspaceId: 'workspace-1',
			deploymentId: 'deployment-1',
			generationId: 'generation-1',
			generationNumber: 1,
			runtimeInstallationId: 'runtime-1',
			mcpAppId: 'mcp-app-1',
			clusterAppId: 'cluster-app-1',
			htm: 'POST',
			htu: '/mcp',
			bodyDigest: sha256Base64Url(canonicalJson(rpc)),
			manifestDigest: `sha256:${'f'.repeat(64)}`,
			resourceManifestHash: 'r'.repeat(43),
			runtimeResourceInventoryHash: 'i'.repeat(43),
			runtimeApprovalReceiptHash: 'b'.repeat(43),
			runtimeGrantEpoch: 7,
			authorizationContext: 'room',
			roomId: 'room-1',
			authorizationBindingId: 'binding-1',
			bindingReceiptHash: 'q'.repeat(43),
			bindingEpoch: 2,
		},
	});

	assert.throws(() => verifyAgentDispatchAssertionV3({
		compact, rpc, labels,
		authorization: {
			authorizationContext: 'workspace', runtimeInstallationId: 'runtime-1',
			runtimeResourceInventoryHash: 'i'.repeat(43),
		},
	}), /ROOM_BINDING_REQUIRED/);
	assert.throws(() => verifyAgentDispatchAssertionV3({
		compact, rpc, labels,
		authorization: {
			authorizationContext: 'room', runtimeInstallationId: 'runtime-1',
			authorizationBindingId: 'binding-wrong', runtimeResourceInventoryHash: 'i'.repeat(43),
		},
	}), (error: unknown) => (error as { code?: string }).code === 'ROOM_BINDING_MISMATCH');
	assert.throws(() => verifyAgentDispatchAssertionV3({
		compact, rpc, labels,
		authorization: {
			authorizationContext: 'room', runtimeInstallationId: 'runtime-wrong',
			authorizationBindingId: 'binding-1', runtimeResourceInventoryHash: 'i'.repeat(43),
		},
	}), /dispatch_assertion_binding_mismatch/);
	assert.doesNotThrow(() => verifyAgentDispatchAssertionV3({
		compact, rpc, labels,
		authorization: {
			authorizationContext: 'room', runtimeInstallationId: 'runtime-1',
			authorizationBindingId: 'binding-1', runtimeResourceInventoryHash: 'i'.repeat(43),
		},
	}));
	assert.throws(() => verifyAgentDispatchAssertionV3({
		compact, rpc, labels,
		authorization: {
			authorizationContext: 'room', runtimeInstallationId: 'runtime-1',
			authorizationBindingId: 'binding-1', runtimeResourceInventoryHash: 'i'.repeat(43),
		},
	}), /dispatch_assertion_replayed/);
});
