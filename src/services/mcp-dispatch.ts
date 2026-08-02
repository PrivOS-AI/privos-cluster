import { z } from 'zod';
import type { JsonWebKey } from 'node:crypto';

import { assertArtifactTime, canonicalJson, jwkThumbprint, sha256, verifyEs256Jws } from '../security/artifacts.js';

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
