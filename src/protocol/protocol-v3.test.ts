import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
	jwkThumbprint,
	sha256Base64Url,
	signEs256Jws,
} from '../security/artifacts.js';
import {
	ClusterReconfigureCommandPayloadV3Schema,
	ClusterUpgradeCommandPayloadV3Schema,
	McpProtocolV3Error,
	acquisitionAffinityHashV3,
	assertClusterLifecycleTransitionV3,
	assertDispatchAffinityV3,
	assertRuntimeGenerationTransitionV3,
	parseDispatchAssertionPayloadV3,
	parseRoomlessAcquisitionAffinityV3,
	verifyDeploymentGrantV3,
	verifyDispatchAssertionV3,
	verifyLifecycleCommandV3,
	verifyNodeCleanupResultV3,
	verifyUpgradeCommandV3,
} from './protocol-v3.js';

const contentDigest = (character: string) => `sha256:${character.repeat(64)}`;
const artifactHash = (value: string) => sha256Base64Url(value);
const nonce = 'abcdefghijklmnopQRSTUVWX';

function ecIdentity() {
	const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const privateJwk = pair.privateKey.export({ format: 'jwk' });
	const publicJwk = pair.publicKey.export({ format: 'jwk' });
	return { privateJwk, publicJwk, kid: jwkThumbprint(publicJwk) };
}

function signEdDsaForSubstitution(payload: Record<string, unknown>, typ: string) {
	const pair = crypto.generateKeyPairSync('ed25519');
	const publicJwk = pair.publicKey.export({ format: 'jwk' });
	const kid = 'ed25519-substitution-test-key';
	const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid, typ, privos_protocol: 3 })).toString('base64url');
	const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const signingInput = Buffer.from(`${header}.${encodedPayload}`);
	const signature = crypto.sign(null, signingInput, pair.privateKey).toString('base64url');
	return { compact: `${header}.${encodedPayload}.${signature}`, publicJwk, kid };
}

function timed(issuer: string, lifetimeSeconds = 60) {
	const now = Math.floor(Date.now() / 1000);
	return {
		protocolVersion: 3,
		iss: issuer,
		jti: crypto.randomUUID(),
		nonce,
		iat: now,
		exp: now + lifetimeSeconds,
	};
}

const affinity = {
	clusterId: 'cluster-1',
	workspaceId: 'workspace-1',
	deploymentId: 'deployment-1',
	generationId: 'generation-1',
	generationNumber: 1,
	runtimeInstallationId: 'runtime-1',
	resourceManifestHash: artifactHash('resource-manifest'),
	runtimeResourceInventoryHash: artifactHash('runtime-resource-inventory'),
	issuer: 'urn:privos:hub:deployment-1',
};

const provisioningAffinity = {
	clusterId: affinity.clusterId,
	workspaceId: affinity.workspaceId,
	deploymentId: affinity.deploymentId,
	generationId: affinity.generationId,
	generationNumber: affinity.generationNumber,
	runtimeInstallationId: affinity.runtimeInstallationId,
	resourceManifestHash: affinity.resourceManifestHash,
	issuer: affinity.issuer,
};

function deploymentGrantPayload() {
	return {
		...timed(affinity.issuer),
		type: 'mcp-deployment-grant',
		aud: 'privos-apps-master',
		clusterId: affinity.clusterId,
		workspaceId: affinity.workspaceId,
		deploymentId: affinity.deploymentId,
		generationId: affinity.generationId,
		generationNumber: 1,
		runtimeInstallationId: affinity.runtimeInstallationId,
		mcpAppId: 'mcp-app-1',
		acquisitionAffinityHash: artifactHash('acquisition'),
		approvalReceiptHash: artifactHash('approval'),
		approvedPermissionCeilingHash: artifactHash('permission-ceiling'),
		authorizationEpoch: 1,
		hubOrigin: 'https://hub.example.com',
		deployment: {
			clusterAppId: 'cluster-app-1',
			listingId: 'listing-1',
			versionId: 'version-1',
			versionDigest: contentDigest('a'),
			image: `registry.example/app@${contentDigest('b')}`,
			imageDigest: contentDigest('b'),
			manifestDigest: contentDigest('c'),
			resourceManifestHash: affinity.resourceManifestHash,
			port: 3001,
			resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64 },
			envVars: {},
			volumes: [{ name: 'data', mountPath: '/data' }],
			availabilityTier: 'single',
			stateless: false,
			releaseAttestationJws: 'signed.release.attestation.'.padEnd(40, 'x'),
			subdomain: 'app',
			domain: 'apps.example.com',
		},
	};
}

function lifecyclePayload(overrides: Record<string, unknown> = {}) {
	return {
		...timed(affinity.issuer),
		type: 'cluster-lifecycle-command',
		aud: 'privos-apps-master',
		action: 'UNINSTALL_RUNTIME',
		operationId: '11111111-1111-4111-8111-111111111111',
		clusterId: affinity.clusterId,
		workspaceId: affinity.workspaceId,
		deploymentId: affinity.deploymentId,
		generationId: affinity.generationId,
		generationNumber: 1,
		runtimeInstallationId: affinity.runtimeInstallationId,
		clusterAppId: 'cluster-app-1',
		manifestDigest: contentDigest('c'),
		resourceManifestHash: affinity.resourceManifestHash,
		runtimeResourceInventoryHash: affinity.runtimeResourceInventoryHash,
		reasonCode: 'ADMIN_UNINSTALL',
		expectedResourceCount: 4,
		...overrides,
	};
}

function upgradePayload(overrides: Record<string, unknown> = {}) {
	return {
		...timed(affinity.issuer),
		type: 'cluster-upgrade-command',
		aud: 'privos-apps-master',
		action: 'UPGRADE_RUNTIME',
		operationId: '11111111-1111-4111-8111-111111111111',
		clusterId: affinity.clusterId,
		workspaceId: affinity.workspaceId,
		deploymentId: affinity.deploymentId,
		generationId: affinity.generationId,
		generationNumber: 1,
		revision: 1,
		runtimeInstallationId: affinity.runtimeInstallationId,
		clusterAppId: 'cluster-app-1',
		mcpAppId: 'mcp-app-1',
		targetManifestDigest: contentDigest('f'),
		targetImageDigest: contentDigest('f'),
		previousManifestDigest: contentDigest('c'),
		previousImageDigest: contentDigest('b'),
		resourceManifestHash: affinity.resourceManifestHash,
		runtimeResourceInventoryHash: affinity.runtimeResourceInventoryHash,
		authorizationEpoch: 1,
		resultingAuthorizationEpoch: 2,
		upgradeEpoch: 1,
		...overrides,
	};
}

function tamperPayload(compact: string, mutate: (payload: Record<string, unknown>) => void): string {
	const [header, encodedPayload, signature] = compact.split('.');
	const payload = JSON.parse(Buffer.from(encodedPayload!, 'base64url').toString('utf8')) as Record<string, unknown>;
	mutate(payload);
	return `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
}

function assertV3Error(fn: () => unknown, code: string): void {
	assert.throws(fn, (error: unknown) => error instanceof McpProtocolV3Error && error.code === code);
}

test('roomless acquisition rejects recursive room affinity and uses canonical base64url hashes', () => {
	const proposal = {
		protocolVersion: 3,
		type: 'mcp-acquisition-affinity',
		listingId: 'listing-1',
		versionId: 'version-1',
		offerId: 'offer-1',
		workspaceId: 'workspace-1',
		deploymentId: 'deployment-1',
		executionMode: 'PRIVOS_MANAGED_RUNTIME',
		availabilityTier: 'single',
		commercial: { pricingModel: 'FREE', amountCents: 0, currency: 'USD' },
		manifestDigest: contentDigest('a'),
		permissionCeilingHash: artifactHash('ceiling'),
		dataPolicyHash: artifactHash('data-policy'),
	} as const;
	const parsed = parseRoomlessAcquisitionAffinityV3(proposal);
	assert.match(acquisitionAffinityHashV3(parsed), /^[A-Za-z0-9_-]{43}$/);
	assert.equal(
		acquisitionAffinityHashV3(parsed),
		acquisitionAffinityHashV3(parseRoomlessAcquisitionAffinityV3({ ...proposal })),
	);
	assertV3Error(
		() => parseRoomlessAcquisitionAffinityV3({ ...proposal, target: { roomId: 'room-1' } }),
		'ACQUISITION_ROOM_AFFINITY_FORBIDDEN',
	);
	assertV3Error(
		() => parseRoomlessAcquisitionAffinityV3({ ...proposal, target: { type: 'room', id: 'room-1' } }),
		'ACQUISITION_ROOM_AFFINITY_FORBIDDEN',
	);
	assertV3Error(
		() => parseRoomlessAcquisitionAffinityV3({ ...proposal, unknown: true }),
		'PROTOCOL_ENVELOPE_INVALID',
	);
});

test('deployment grants are strict, signed by Hub ES256, and generation affine', () => {
	const hub = ecIdentity();
	const payload = deploymentGrantPayload();
	const compact = signEs256Jws({
		payload,
		privateJwk: hub.privateJwk,
		kid: hub.kid,
		typ: 'privos-deployment-grant+jws',
		protocolVersion: 3,
	});
	const verified = verifyDeploymentGrantV3({
		compact,
		publicJwk: hub.publicJwk,
		kid: hub.kid,
		expected: provisioningAffinity,
	});
	assert.equal(verified.generationId, 'generation-1');
	assert.equal(Object.hasOwn(verified.deployment, 'runtimeResourceInventoryHash'), false);
	assertV3Error(
		() => verifyDeploymentGrantV3({
			compact,
			publicJwk: hub.publicJwk,
			kid: hub.kid,
			expected: { ...provisioningAffinity, generationId: 'generation-2' },
		}),
		'GENERATION_AFFINITY_MISMATCH',
	);
	const prematureLocalInventoryHash = signEs256Jws({
		payload: {
			...payload,
			deployment: {
				...payload.deployment,
				runtimeResourceInventoryHash: affinity.runtimeResourceInventoryHash,
			},
		},
		privateJwk: hub.privateJwk,
		kid: hub.kid,
		typ: 'privos-deployment-grant+jws',
		protocolVersion: 3,
	});
	assertV3Error(
		() => verifyDeploymentGrantV3({
			compact: prematureLocalInventoryHash,
			publicJwk: hub.publicJwk,
			kid: hub.kid,
			expected: provisioningAffinity,
		}),
		'PROTOCOL_ENVELOPE_INVALID',
	);
	const roomAffineGrant = signEs256Jws({
		payload: { ...payload, roomId: 'room-1' },
		privateJwk: hub.privateJwk,
		kid: hub.kid,
		typ: 'privos-deployment-grant+jws',
		protocolVersion: 3,
	});
	assertV3Error(
		() => verifyDeploymentGrantV3({
			compact: roomAffineGrant,
			publicJwk: hub.publicJwk,
			kid: hub.kid,
			expected: provisioningAffinity,
		}),
		'PROTOCOL_ENVELOPE_INVALID',
	);
});

test('a reinstall reaches Cluster only as a fresh Hub deployment generation', () => {
	const hub = ecIdentity();
	const sign = (payload: Record<string, unknown>) => signEs256Jws({
		payload,
		privateJwk: hub.privateJwk,
		kid: hub.kid,
		typ: 'privos-deployment-grant+jws',
		protocolVersion: 3,
	});
	const freshPayload = {
		...deploymentGrantPayload(),
		generationId: 'generation-2',
		generationNumber: 2,
		runtimeInstallationId: 'runtime-2',
	};
	const freshExpected = {
		...provisioningAffinity,
		generationId: 'generation-2',
		generationNumber: 2,
		runtimeInstallationId: 'runtime-2',
		previousGeneration: {
			generationId: 'generation-1',
			generationNumber: 1,
			runtimeInstallationId: 'runtime-1',
		},
	};
	assert.equal(verifyDeploymentGrantV3({
		compact: sign(freshPayload),
		publicJwk: hub.publicJwk,
		kid: hub.kid,
		expected: freshExpected,
	}).generationNumber, 2);
	assertV3Error(
		() => verifyDeploymentGrantV3({
			compact: sign(deploymentGrantPayload()),
			publicJwk: hub.publicJwk,
			kid: hub.kid,
			expected: {
				...provisioningAffinity,
				previousGeneration: freshExpected.previousGeneration,
			},
		}),
		'GENERATION_IDENTITY_REUSED',
	);
});

test('room dispatch requires the runtime parent and exact room-binding child', () => {
	const common = {
		...timed(affinity.issuer, 30),
		type: 'hub-dispatch-assertion',
		aud: 'privos-mcp-app',
		clusterId: affinity.clusterId,
		workspaceId: affinity.workspaceId,
		deploymentId: affinity.deploymentId,
		generationId: affinity.generationId,
		generationNumber: 1,
		runtimeInstallationId: affinity.runtimeInstallationId,
		mcpAppId: 'mcp-app-1',
		clusterAppId: 'cluster-app-1',
		htm: 'POST',
		htu: '/mcp',
		bodyDigest: artifactHash('rpc-body'),
		manifestDigest: contentDigest('c'),
		resourceManifestHash: affinity.resourceManifestHash,
		runtimeResourceInventoryHash: affinity.runtimeResourceInventoryHash,
		runtimeApprovalReceiptHash: artifactHash('runtime-approval'),
		runtimeGrantEpoch: 1,
	} as const;
	assertV3Error(
		() => parseDispatchAssertionPayloadV3({ ...common, authorizationContext: 'room', roomId: 'room-1' }),
		'ROOM_BINDING_REQUIRED',
	);
	assertV3Error(
		() => parseDispatchAssertionPayloadV3({
			...common,
			authorizationContext: 'workspace',
			roomId: 'room-1',
		}),
		'PROTOCOL_ENVELOPE_INVALID',
	);
	const room = parseDispatchAssertionPayloadV3({
		...common,
		authorizationContext: 'room',
		roomId: 'room-1',
		authorizationBindingId: 'binding-1',
		bindingReceiptHash: artifactHash('binding-receipt'),
		bindingEpoch: 1,
	});
	const expected = {
		...affinity,
		authorizationContext: 'room' as const,
		roomId: 'room-1',
		authorizationBindingId: 'binding-1',
		bindingReceiptHash: artifactHash('binding-receipt'),
		bindingEpoch: 1,
		bodyDigest: common.bodyDigest,
		manifestDigest: common.manifestDigest,
		runtimeApprovalReceiptHash: common.runtimeApprovalReceiptHash,
		runtimeGrantEpoch: common.runtimeGrantEpoch,
	};
	assert.doesNotThrow(() => assertDispatchAffinityV3(room, expected));
	assertV3Error(
		() => assertDispatchAffinityV3(room, { ...expected, authorizationBindingId: 'binding-2' }),
		'ROOM_BINDING_MISMATCH',
	);
	const hub = ecIdentity();
	const compact = signEs256Jws({
		payload: room,
		privateJwk: hub.privateJwk,
		kid: hub.kid,
		typ: 'privos-hub-dispatch+jws',
		protocolVersion: 3,
	});
	assert.equal(verifyDispatchAssertionV3({ compact, publicJwk: hub.publicJwk, kid: hub.kid, expected }).authorizationContext, 'room');
});

test('an optional actor claim is accepted, ignored by affinity, and never required', () => {
	const common = {
		...timed(affinity.issuer, 30),
		type: 'hub-dispatch-assertion',
		aud: 'privos-mcp-app',
		clusterId: affinity.clusterId,
		workspaceId: affinity.workspaceId,
		deploymentId: affinity.deploymentId,
		generationId: affinity.generationId,
		generationNumber: 1,
		runtimeInstallationId: affinity.runtimeInstallationId,
		mcpAppId: 'mcp-app-1',
		clusterAppId: 'cluster-app-1',
		htm: 'POST',
		htu: '/mcp',
		bodyDigest: artifactHash('rpc-body'),
		manifestDigest: contentDigest('c'),
		resourceManifestHash: affinity.resourceManifestHash,
		runtimeResourceInventoryHash: affinity.runtimeResourceInventoryHash,
		runtimeApprovalReceiptHash: artifactHash('runtime-approval'),
		runtimeGrantEpoch: 1,
	} as const;
	const roomBinding = {
		authorizationContext: 'room' as const,
		roomId: 'room-1',
		authorizationBindingId: 'binding-1',
		bindingReceiptHash: artifactHash('binding-receipt'),
		bindingEpoch: 1,
	};
	const expected = {
		...affinity,
		...roomBinding,
		bodyDigest: common.bodyDigest,
		manifestDigest: common.manifestDigest,
		runtimeApprovalReceiptHash: common.runtimeApprovalReceiptHash,
		runtimeGrantEpoch: common.runtimeGrantEpoch,
	};

	// Every Hub in the fleet signs no actor today, and an agent or roomless
	// dispatch never will. Absence has to stay valid or the fleet stops.
	const withoutActor = parseDispatchAssertionPayloadV3({ ...common, ...roomBinding });
	assert.equal(withoutActor.actor, undefined);
	assert.doesNotThrow(() => assertDispatchAffinityV3(withoutActor, expected));
	assert.doesNotThrow(() => parseDispatchAssertionPayloadV3({ ...common, authorizationContext: 'workspace' }));

	const withActor = parseDispatchAssertionPayloadV3({
		...common,
		...roomBinding,
		actor: { subject: 'user-1', username: 'techcomthanh', roomId: 'room-1' },
	});
	assert.deepEqual(withActor.actor, { subject: 'user-1', username: 'techcomthanh', roomId: 'room-1' });

	// The claim is opaque metadata: affinity must reach the same verdict with it,
	// without it, and with a different one. Nothing may key off the actor.
	assert.doesNotThrow(() => assertDispatchAffinityV3(withActor, expected));
	assert.doesNotThrow(() => assertDispatchAffinityV3(
		parseDispatchAssertionPayloadV3({ ...common, ...roomBinding, actor: { subject: 'someone-else' } }),
		expected,
	));

	// A workspace-context assertion may carry one too — it is not room affinity.
	assert.deepEqual(
		parseDispatchAssertionPayloadV3({
			...common,
			authorizationContext: 'workspace',
			actor: { subject: 'user-1' },
		}).actor,
		{ subject: 'user-1' },
	);

	// Strictness is the property that makes the claim safe to add: the actor is a
	// well-typed optional key, not a passthrough for anything a signer feels like.
	for (const malformed of [
		{ username: 'no-subject' },
		{ subject: '' },
		{ subject: 42 },
		{ subject: 'user-1', username: 7 },
		{ subject: 'user-1', unexpected: 'x' },
		'user-1',
		null,
	]) {
		assertV3Error(
			() => parseDispatchAssertionPayloadV3({ ...common, ...roomBinding, actor: malformed }),
			'PROTOCOL_ENVELOPE_INVALID',
		);
	}
	assertV3Error(
		() => parseDispatchAssertionPayloadV3({ ...common, ...roomBinding, unknownClaim: 'x' }),
		'PROTOCOL_ENVELOPE_INVALID',
	);

	// The app must receive exactly the bytes the Hub signed, actor included.
	const hub = ecIdentity();
	const compact = signEs256Jws({
		payload: withActor,
		privateJwk: hub.privateJwk,
		kid: hub.kid,
		typ: 'privos-hub-dispatch+jws',
		protocolVersion: 3,
	});
	assert.deepEqual(
		verifyDispatchAssertionV3({ compact, publicJwk: hub.publicJwk, kid: hub.kid, expected }).actor,
		{ subject: 'user-1', username: 'techcomthanh', roomId: 'room-1' },
	);
});

test('lifecycle commands reject tamper, expiry, protocol downgrade, and generation transplant', () => {
	const hub = ecIdentity();
	const sign = (payload: Record<string, unknown>, protocolVersion = 3) => signEs256Jws({
		payload,
		privateJwk: hub.privateJwk,
		kid: hub.kid,
		typ: 'privos-cluster-lifecycle-command+jws',
		protocolVersion,
	});
	const compact = sign(lifecyclePayload());
	assert.equal(verifyLifecycleCommandV3({ compact, publicJwk: hub.publicJwk, kid: hub.kid, expected: affinity }).operationId, '11111111-1111-4111-8111-111111111111');
	assertV3Error(
		() => verifyLifecycleCommandV3({
			compact: tamperPayload(compact, (payload) => { payload.generationId = 'generation-2'; }),
			publicJwk: hub.publicJwk,
			kid: hub.kid,
			expected: affinity,
		}),
		'ARTIFACT_SIGNATURE_INVALID',
	);
	const now = Math.floor(Date.now() / 1000);
	assertV3Error(
		() => verifyLifecycleCommandV3({
			compact: sign(lifecyclePayload({ iat: now - 200, exp: now - 100 })),
			publicJwk: hub.publicJwk,
			kid: hub.kid,
			expected: affinity,
		}),
		'ARTIFACT_TIME_INVALID',
	);
	assertV3Error(
		() => verifyLifecycleCommandV3({ compact: sign(lifecyclePayload(), 2), publicJwk: hub.publicJwk, kid: hub.kid, expected: affinity }),
		'PROTOCOL_VERSION_UNSUPPORTED',
	);
	assertV3Error(
		() => verifyLifecycleCommandV3({
			compact,
			publicJwk: hub.publicJwk,
			kid: hub.kid,
			expected: { ...affinity, resourceManifestHash: artifactHash('other-manifest') },
		}),
		'RESOURCE_MANIFEST_HASH_MISMATCH',
	);
	assertV3Error(
		() => verifyLifecycleCommandV3({
			compact,
			publicJwk: hub.publicJwk,
			kid: hub.kid,
			expected: { ...affinity, runtimeResourceInventoryHash: artifactHash('other-runtime-inventory') },
		}),
		'RUNTIME_RESOURCE_INVENTORY_HASH_MISMATCH',
	);
});

test('artifact verifier pins Hub and Cluster artifacts to ES256', () => {
	const substituted = signEdDsaForSubstitution(
		lifecyclePayload(),
		'privos-cluster-lifecycle-command+jws',
	);
	assertV3Error(
		() => verifyLifecycleCommandV3({
			compact: substituted.compact,
			publicJwk: substituted.publicJwk,
			kid: substituted.kid,
			expected: affinity,
		}),
		'ARTIFACT_SIGNATURE_INVALID',
	);
});

test('node cleanup evidence is ES256-signed and generation affine', () => {
	const node = ecIdentity();
	const payload = {
		...timed('urn:privos:cluster-node:node-1'),
		type: 'cluster-node-cleanup-result',
		aud: 'privos-apps-master',
		operationId: '11111111-1111-4111-8111-111111111111',
		clusterId: affinity.clusterId,
		nodeId: 'node-1',
		workspaceId: affinity.workspaceId,
		deploymentId: affinity.deploymentId,
		generationId: affinity.generationId,
		generationNumber: affinity.generationNumber,
		runtimeInstallationId: affinity.runtimeInstallationId,
		resourceManifestHash: affinity.resourceManifestHash,
		runtimeResourceInventoryHash: affinity.runtimeResourceInventoryHash,
		complete: true,
		results: [{
			kind: 'CONTAINER',
			resourceId: 'container-1',
			status: 'REMOVED',
			reasonCode: null,
			verifiedAt: new Date().toISOString(),
		}],
	};
	const compact = signEs256Jws({
		payload,
		privateJwk: node.privateJwk,
		kid: node.kid,
		typ: 'privos-cluster-node-cleanup-result+jws',
		protocolVersion: 3,
	});
	assert.equal(verifyNodeCleanupResultV3({
		compact,
		publicJwk: node.publicJwk,
		kid: node.kid,
		expected: { ...affinity, issuer: 'urn:privos:cluster-node:node-1' },
	}).complete, true);
});

test('upgrade commands reject tamper, expiry, generation transplant, and an epoch that does not match its revision', () => {
	const hub = ecIdentity();
	const sign = (payload: Record<string, unknown>, protocolVersion = 3) => signEs256Jws({
		payload,
		privateJwk: hub.privateJwk,
		kid: hub.kid,
		typ: 'privos-cluster-upgrade-command+jws',
		protocolVersion,
	});
	const expected = { ...affinity, clusterAppId: 'cluster-app-1', mcpAppId: 'mcp-app-1' };
	const compact = sign(upgradePayload());
	const verified = verifyUpgradeCommandV3({ compact, publicJwk: hub.publicJwk, kid: hub.kid, expected });
	assert.equal(verified.revision, 1);
	assert.equal(verified.targetManifestDigest, contentDigest('f'));
	assert.equal(verified.previousManifestDigest, contentDigest('c'));

	assertV3Error(
		() => verifyUpgradeCommandV3({
			compact: tamperPayload(compact, (payload) => { payload.generationId = 'generation-2'; }),
			publicJwk: hub.publicJwk,
			kid: hub.kid,
			expected,
		}),
		'ARTIFACT_SIGNATURE_INVALID',
	);
	const now = Math.floor(Date.now() / 1000);
	assertV3Error(
		() => verifyUpgradeCommandV3({
			compact: sign(upgradePayload({ iat: now - 200, exp: now - 100 })),
			publicJwk: hub.publicJwk,
			kid: hub.kid,
			expected,
		}),
		'ARTIFACT_TIME_INVALID',
	);
	assertV3Error(
		() => verifyUpgradeCommandV3({ compact: sign(upgradePayload(), 2), publicJwk: hub.publicJwk, kid: hub.kid, expected }),
		'PROTOCOL_VERSION_UNSUPPORTED',
	);
	assertV3Error(
		() => verifyUpgradeCommandV3({
			compact,
			publicJwk: hub.publicJwk,
			kid: hub.kid,
			expected: { ...expected, mcpAppId: 'mcp-app-2' },
		}),
		'GENERATION_AFFINITY_MISMATCH',
	);
	// A different generationNumber names a different generation entirely — the
	// same class of refusal a reused generation identity gets at install.
	assertV3Error(
		() => verifyUpgradeCommandV3({
			compact,
			publicJwk: hub.publicJwk,
			kid: hub.kid,
			expected: { ...expected, generationNumber: 2 },
		}),
		'GENERATION_AFFINITY_MISMATCH',
	);
});

test('the upgrade command schema refuses an upgradeEpoch that does not equal its revision, and a target identical to its previous image', () => {
	const mismatchedEpoch = ClusterUpgradeCommandPayloadV3Schema.safeParse(upgradePayload({ upgradeEpoch: 2 }));
	assert.equal(mismatchedEpoch.success, false);

	const noOpTarget = ClusterUpgradeCommandPayloadV3Schema.safeParse(upgradePayload({
		targetManifestDigest: contentDigest('c'),
		targetImageDigest: contentDigest('b'),
	}));
	assert.equal(noOpTarget.success, false);

	assert.equal(ClusterUpgradeCommandPayloadV3Schema.safeParse(upgradePayload()).success, true);
});

test('runtime and lifecycle transition graphs allow idempotent delivery but reject regressions', () => {
	assert.doesNotThrow(() => assertRuntimeGenerationTransitionV3('ACTIVE', 'ACTIVE'));
	assert.doesNotThrow(() => assertRuntimeGenerationTransitionV3('ACTIVE', 'REVOKING'));
	assert.doesNotThrow(() => assertRuntimeGenerationTransitionV3('REVOKING', 'CLEANUP_REQUIRED'));
	assert.doesNotThrow(() => assertRuntimeGenerationTransitionV3('CLEANUP_REQUIRED', 'UNINSTALLED'));
	assertV3Error(() => assertRuntimeGenerationTransitionV3('UNINSTALLED', 'ACTIVE'), 'INVALID_LIFECYCLE_TRANSITION');
	assert.doesNotThrow(() => assertClusterLifecycleTransitionV3('VERIFYING', 'VERIFYING'));
	assert.doesNotThrow(() => assertClusterLifecycleTransitionV3('VERIFYING', 'COMPLETED'));
	assertV3Error(() => assertClusterLifecycleTransitionV3('COMPLETED', 'RUNTIME_REMOVING'), 'INVALID_LIFECYCLE_TRANSITION');
});

test('the reconfigure command envelope admits the Hub-issued agent-bot pair and still refuses the rest of the PRIVOS_ namespace', () => {
	const payload = {
		...timed(affinity.issuer),
		type: 'cluster-reconfigure-command',
		aud: 'privos-apps-master',
		action: 'RECONFIGURE_RUNTIME',
		operationId: '33333333-3333-4333-8333-333333333333',
		clusterId: affinity.clusterId,
		workspaceId: affinity.workspaceId,
		deploymentId: affinity.deploymentId,
		generationId: affinity.generationId,
		generationNumber: 1,
		runtimeInstallationId: affinity.runtimeInstallationId,
		clusterAppId: 'cluster-app-1',
		mcpAppId: 'mcp-app-1',
		manifestDigest: contentDigest('c'),
		resourceManifestHash: affinity.resourceManifestHash,
		runtimeResourceInventoryHash: affinity.runtimeResourceInventoryHash,
		authorizationEpoch: 1,
		configEpoch: 2,
		envVars: {
			APP_MODE: 'demo',
			PRIVOS_AGENT_BOT_CREDENTIAL: 'secret-credential',
			PRIVOS_AGENT_BOT_USER_ID: 'bot-user-1',
		},
		secretKeys: ['PRIVOS_AGENT_BOT_CREDENTIAL'],
	};
	assert.equal(ClusterReconfigureCommandPayloadV3Schema.safeParse(payload).success, true);
	assert.equal(ClusterReconfigureCommandPayloadV3Schema.safeParse({
		...payload,
		envVars: { ...payload.envVars, PRIVOS_PUBLIC_URL: 'https://spoof.example' },
	}).success, false);
	assert.equal(ClusterReconfigureCommandPayloadV3Schema.safeParse({
		...payload,
		envVars: { ...payload.envVars, PRIVOS_ANYTHING_ELSE: 'value' },
	}).success, false);
});

test('the reconfigure command admits an optional size-package resize and keeps its bounds strict', () => {
	const payload = {
		...timed(affinity.issuer),
		type: 'cluster-reconfigure-command',
		aud: 'privos-apps-master',
		action: 'RECONFIGURE_RUNTIME',
		operationId: '33333333-3333-4333-8333-333333333333',
		clusterId: affinity.clusterId,
		workspaceId: affinity.workspaceId,
		deploymentId: affinity.deploymentId,
		generationId: affinity.generationId,
		generationNumber: 1,
		runtimeInstallationId: affinity.runtimeInstallationId,
		clusterAppId: 'cluster-app-1',
		mcpAppId: 'mcp-app-1',
		manifestDigest: contentDigest('c'),
		resourceManifestHash: affinity.resourceManifestHash,
		runtimeResourceInventoryHash: affinity.runtimeResourceInventoryHash,
		authorizationEpoch: 1,
		configEpoch: 2,
		envVars: {},
		secretKeys: [],
	};
	// Absent resources — today's environment-only reconfigure — still parses.
	assert.equal(ClusterReconfigureCommandPayloadV3Schema.safeParse(payload).success, true);
	// The XL ceiling (4096MB/4cpu) parses; one step past it does not.
	assert.equal(ClusterReconfigureCommandPayloadV3Schema.safeParse({
		...payload,
		resources: { memoryMb: 4096, cpus: 4, tmpSizeMb: 1024 },
	}).success, true);
	assert.equal(ClusterReconfigureCommandPayloadV3Schema.safeParse({
		...payload,
		resources: { memoryMb: 4097, cpus: 4, tmpSizeMb: 1024 },
	}).success, false);
	// resources stays as strict as the envelope it lives in.
	assert.equal(ClusterReconfigureCommandPayloadV3Schema.safeParse({
		...payload,
		resources: { memoryMb: 256, cpus: 0.5, tmpSizeMb: 64, gpuCount: 1 },
	}).success, false);
});
