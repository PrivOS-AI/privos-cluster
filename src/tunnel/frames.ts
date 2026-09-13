/**
 * Dial-out tunnel frame codec — mirror of the phase-1 normative contract
 * (`plans/260911-1857-.../artifacts/wire-contracts.md` section (a) and
 * `artifacts/tunnel-frame-vectors.json`). This module MUST NOT redefine
 * shapes or caps; it implements the frozen contract only. Drift from the
 * shared vectors is a failing test (`frames.test.ts`), not a field incident.
 */
import { z } from 'zod';

/** Wire/protocol version. A mismatch between Hub and App Cluster builds is a codec test failure, not a wire field (see wire-contracts.md "Version field"). */
export const FRAME_VERSION = 1;

/** JSON control-frame body cap (all frame types, and `req-chunk`'s control half). */
export const MAX_JSON_FRAME_BYTES = 1_000_000;
/** `req-chunk` binary payload cap, enforced against the actual received byte length. */
export const MAX_CHUNK_BYTES = 1024 * 1024;
/** Total staged artifact cap across all chunks of one `stage` op (the Portal's own ceiling). */
export const MAX_STAGED_ARTIFACT_BYTES = 250_000_000;

const HeadersSchema = z.record(z.string(), z.string());

const ClusterCapabilitiesSchema = z.object({
	operatorRoutes: z.boolean(),
	artifactStaging: z.boolean(),
});

/** Public identity summary only — never carries private key material. */
const NodeIdentitySchema = z.object({
	nodeId: z.string(),
	kid: z.string(),
	publicJwk: z.object({
		kty: z.literal('EC'),
		crv: z.literal('P-256'),
		x: z.string(),
		y: z.string(),
	}),
});

const HelloFrameSchema = z.object({
	t: z.literal('hello'),
	version: z.string(),
	clusterId: z.string(),
	clusterCapabilities: ClusterCapabilitiesSchema,
	// Additive (optional): a hub that predates this field still parses the
	// frame fine, and a cluster that fails to load its node identity still
	// connects — see `tunnel-client.ts`'s `loadNodeIdentity`.
	nodeIdentity: NodeIdentitySchema.optional(),
});

const ReqFrameSchema = z.object({
	t: z.literal('req'),
	id: z.string(),
	method: z.string(),
	path: z.string(),
	query: HeadersSchema.optional(),
	headers: HeadersSchema.optional(),
	body: z.unknown().optional(),
	raw: z.boolean().optional(),
	rawBody: z.string().optional(),
	timeoutMs: z.number(),
});

const ReqChunkFrameSchema = z.object({
	t: z.literal('req-chunk'),
	id: z.string(),
	seq: z.number(),
	byteLength: z.number(),
	sha256: z.string().optional(),
	last: z.boolean(),
});

const ResFrameSchema = z.object({
	t: z.literal('res'),
	id: z.string(),
	status: z.number(),
	headers: HeadersSchema.optional(),
	body: z.unknown().optional(),
	raw: z.boolean().optional(),
	rawBody: z.string().optional(),
	error: z.object({ code: z.string(), message: z.string() }).optional(),
});

const ForwardFrameSchema = z.object({
	t: z.literal('forward'),
	id: z.string(),
	runtimeId: z.string(),
	path: z.string(),
	headers: HeadersSchema.optional(),
	body: z.unknown().optional(),
	timeoutMs: z.number(),
});

const PingFrameSchema = z.object({ t: z.literal('ping'), at: z.number() });
const PongFrameSchema = z.object({ t: z.literal('pong'), at: z.number() });

const PairedFrameSchema = z.object({
	t: z.literal('paired'),
	clusterId: z.string(),
	credential: z.string(),
});

const FrameSchema = z.discriminatedUnion('t', [
	HelloFrameSchema,
	ReqFrameSchema,
	ReqChunkFrameSchema,
	ResFrameSchema,
	ForwardFrameSchema,
	PingFrameSchema,
	PongFrameSchema,
	PairedFrameSchema,
]);

export type HelloFrame = z.infer<typeof HelloFrameSchema>;
export type ReqFrame = z.infer<typeof ReqFrameSchema>;
export type ReqChunkFrame = z.infer<typeof ReqChunkFrameSchema>;
export type ResFrame = z.infer<typeof ResFrameSchema>;
export type ForwardFrame = z.infer<typeof ForwardFrameSchema>;
export type PingFrame = z.infer<typeof PingFrameSchema>;
export type PongFrame = z.infer<typeof PongFrameSchema>;
export type PairedFrame = z.infer<typeof PairedFrameSchema>;
export type Frame = z.infer<typeof FrameSchema>;

/** Thrown by `encodeFrame` when the serialized frame exceeds the 1 MB JSON cap. */
export class FrameEncodeError extends Error {}

/** Thrown by `decodeFrame` on malformed JSON, an unknown/missing shape, or an over-cap frame. Callers close the socket `4400` (`bad_frame`, wire-contracts.md). */
export class FrameDecodeError extends Error {
	readonly closeCode = 4400;
}

/** Serializes a frame to its wire JSON string. Throws `FrameEncodeError` if it exceeds the 1 MB cap. */
export function encodeFrame(frame: Frame): string {
	const json = JSON.stringify(frame);
	if (Buffer.byteLength(json, 'utf8') > MAX_JSON_FRAME_BYTES) {
		throw new FrameEncodeError(`frame '${frame.t}' exceeds the ${MAX_JSON_FRAME_BYTES}-byte JSON cap`);
	}
	return json;
}

/** Parses and validates a wire JSON string into a `Frame`. Throws `FrameDecodeError` (closeCode 4400) on any violation, including the 1 MB cap. */
export function decodeFrame(text: string): Frame {
	if (Buffer.byteLength(text, 'utf8') > MAX_JSON_FRAME_BYTES) {
		throw new FrameDecodeError(`frame exceeds the ${MAX_JSON_FRAME_BYTES}-byte JSON cap`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new FrameDecodeError('malformed JSON frame');
	}
	const result = FrameSchema.safeParse(parsed);
	if (!result.success) {
		throw new FrameDecodeError(`invalid frame: ${result.error.issues.map((i) => i.message).join('; ')}`);
	}
	return result.data;
}
