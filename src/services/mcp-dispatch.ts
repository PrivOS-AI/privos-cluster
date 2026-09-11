import { z } from 'zod';
import type { JsonWebKey } from 'node:crypto';

import {
	assertArtifactTime,
	canonicalJson,
	jwkThumbprint,
	sha256,
	sha256Base64Url,
	verifyEs256Jws,
} from '../security/artifacts.js';
import {
	parseDispatchAssertionPayloadV3,
	verifyDispatchAssertionV3,
} from '../protocol/protocol-v3.js';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Payload = z.object({
	type: z.literal('hub-dispatch-assertion'),
	aud: z.literal('privos-mcp-app'),
	jti: z.string().uuid(),
	iat: z.number().int(),
	exp: z.number().int(),
	workspaceId: z.string(),
	installationId: z.string(),
	mcpAppId: z.string(),
	clusterAppId: z.string().uuid(),
	replicaId: z.string().uuid(),
	htm: z.literal('POST'),
	htu: z.literal('/mcp'),
	bodyDigest: Digest,
	receiptHash: Digest,
	grantEpoch: z.number().int().positive(),
}).strict();

const replay = new Map<string, number>();

export function verifyAgentDispatchAssertion(input: {
	compact: string;
	rpc: unknown;
	labels: Record<string, string>;
}): void {
	const publicJwk = JSON.parse(input.labels['privos.mcp.hub-jwk'] || 'null') as JsonWebKey;
	const kid = input.labels['privos.mcp.hub-kid'];
	if (!kid || jwkThumbprint(publicJwk) !== kid) throw new Error('dispatch_hub_identity_invalid');
	const parsed = verifyEs256Jws({
		compact: input.compact,
		publicJwk,
		kid,
		typ: 'privos-hub-dispatch+jws',
	});
	const payload = Payload.parse(parsed.payload);
	assertArtifactTime(payload, 30);
	if (
		payload.workspaceId !== input.labels['privos.workspace'] ||
		payload.installationId !== input.labels['privos.mcp.installation'] ||
		payload.mcpAppId !== input.labels['privos.mcp.app'] ||
		payload.clusterAppId !== input.labels['privos.app-id'] ||
		payload.replicaId !== input.labels['privos.mcp.replica'] ||
		payload.receiptHash !== input.labels['privos.mcp.receipt'] ||
		payload.grantEpoch !== Number(input.labels['privos.mcp.grant-epoch']) ||
		payload.bodyDigest !== sha256(canonicalJson(input.rpc))
	) {
		throw new Error('dispatch_assertion_binding_mismatch');
	}
	const now = Math.floor(Date.now() / 1000);
	for (const [jti, expiresAt] of replay) if (expiresAt < now) replay.delete(jti);
	if (replay.has(payload.jti)) throw new Error('dispatch_assertion_replayed');
	replay.set(payload.jti, payload.exp);
}

export function verifyAgentDispatchAssertionV3(input: {
	compact: string;
	rpc: unknown;
	labels: Record<string, string>;
	authorization: {
		authorizationContext: 'workspace';
		runtimeInstallationId: string;
		runtimeResourceInventoryHash: string;
	} | {
		authorizationContext: 'room';
		runtimeInstallationId: string;
		authorizationBindingId: string;
		runtimeResourceInventoryHash: string;
	};
}): void {
	const publicJwk = JSON.parse(input.labels['privos.mcp.hub-jwk'] || 'null') as JsonWebKey;
	const kid = input.labels['privos.mcp.hub-kid'];
	if (!kid || jwkThumbprint(publicJwk) !== kid) throw new Error('dispatch_hub_identity_invalid');
	const unverified = parseDispatchAssertionPayloadV3(
		JSON.parse(Buffer.from(input.compact.split('.')[1] ?? '', 'base64url').toString('utf8')),
	);
	if (
		input.authorization.runtimeInstallationId !== input.labels['privos.mcp.runtime-installation'] ||
		unverified.mcpAppId !== input.labels['privos.mcp.app'] ||
		unverified.clusterAppId !== input.labels['privos.app-id']
	) throw new Error('dispatch_assertion_binding_mismatch');
	if (input.authorization.authorizationContext === 'room' && unverified.authorizationContext !== 'room') {
		throw new Error('ROOM_BINDING_REQUIRED');
	}
	const common = {
		clusterId: input.labels['privos.mcp.cluster']!,
		workspaceId: input.labels['privos.mcp.workspace']!,
		deploymentId: input.labels['privos.mcp.deployment']!,
		generationId: input.labels['privos.mcp.generation']!,
		generationNumber: Number(input.labels['privos.mcp.generation-number']),
		runtimeInstallationId: input.labels['privos.mcp.runtime-installation']!,
		resourceManifestHash: input.labels['privos.mcp.resource-manifest-hash']!,
		runtimeResourceInventoryHash: input.authorization.runtimeResourceInventoryHash,
		issuer: `urn:privos:hub:${input.labels['privos.mcp.deployment']}`,
		manifestDigest: input.labels['privos.mcp.manifest.digest']!,
		runtimeApprovalReceiptHash: input.labels['privos.mcp.approval-receipt']!,
		runtimeGrantEpoch: Number(input.labels['privos.mcp.authorization-epoch']),
		bodyDigest: sha256Base64Url(canonicalJson(input.rpc)),
	};
	const payload = verifyDispatchAssertionV3({
		compact: input.compact,
		publicJwk,
		kid,
		expected: unverified.authorizationContext === 'room' ? {
			...common,
			authorizationContext: 'room',
			roomId: unverified.roomId,
			authorizationBindingId: input.authorization.authorizationContext === 'room'
				? input.authorization.authorizationBindingId
				: undefined,
			bindingReceiptHash: unverified.bindingReceiptHash,
			bindingEpoch: unverified.bindingEpoch,
		} : {
			...common,
			authorizationContext: input.authorization.authorizationContext,
		},
	});
	if (payload.authorizationContext !== input.authorization.authorizationContext) {
		throw new Error(input.authorization.authorizationContext === 'room'
			? 'ROOM_BINDING_REQUIRED'
			: 'dispatch_assertion_binding_mismatch');
	}
	const now = Math.floor(Date.now() / 1000);
	for (const [jti, expiresAt] of replay) if (expiresAt < now) replay.delete(jti);
	if (replay.has(payload.jti)) throw new Error('dispatch_assertion_replayed');
	replay.set(payload.jti, payload.exp);
}
