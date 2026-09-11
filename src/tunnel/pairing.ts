/**
 * App Cluster side of Phase 5 pairing (wire-contracts.md (b) "Pairing / activation
 * state machine" and its "Community bootstrap variant").
 *
 * The header-carried-token redeem, credential persistence, and reconnect are already
 * implemented in `tunnel-client.ts` (`buildAuthHeaders()` sends the pair token from
 * the state dir; `handlePaired()` persists the credential and deletes the token) —
 * this module is NOT a second implementation of that flow. It adds the two pieces
 * `tunnel-client.ts` does not yet have, both consumed by it rather than duplicating it:
 *
 *  1. Community bootstrap (`runCommunityBootstrap`): a plain HTTP pre-flight against
 *     `POST /api/v1/app-clusters-pairing.bootstrap` on the plaintext compose hop
 *     (`http://hub:3000`), mutually HMAC-challenged with the shared
 *     `PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN` so neither side ever sends that token
 *     itself over the wire — only HMAC(nonce) proofs. Wire shape frozen by
 *     `privos-hub/apps/meteor/server/services/app-cluster/app-cluster-bootstrap-pairing.ts`'s
 *     own header comment (wire-contracts.md pins the security properties, not a
 *     byte-level protocol, so that file's doc comment is the normative shape and is
 *     matched here byte-for-byte):
 *
 *       -> { clusterNonce, clusterProof }             clusterProof = hex(HMAC(token, `client:${clusterNonce}`))
 *       <- { ok:true, clusterId, hubNonce, hubProof, token, expiresAt }
 *                                                       hubProof   = hex(HMAC(token, `hub:${clusterNonce}:${hubNonce}`))
 *
 *     The Hub only ever answers `ok:true` after it has verified `clusterProof`
 *     server-side (`redeemBootstrapPairing`), so "the App Cluster proves it before
 *     the Hub mints a credential" needs no separate round trip — the single request
 *     carries that proof. This module verifies `hubProof` itself, in constant time,
 *     BEFORE trusting anything else in the response: a peer that cannot answer the
 *     challenge (network error, malformed body, `ok:false`, or a `hubProof` mismatch)
 *     aborts with no pair token ever written — no credential is ever accepted from an
 *     unproven peer. On success the redeemed one-time pair token is written to the
 *     SAME state-dir file (`PAIR_TOKEN_FILENAME`) the admin-initiated flow uses, so the
 *     very next `tunnel-client.ts` connect attempt redeems it through the identical
 *     `X-Privos-Pair-Token` WS-upgrade path — "same redemption path" is literal here,
 *     not just similar.
 *
 *  2. Terminal "re-pair required" detection (`handleRepairRequiredClose`): per
 *     wire-contracts.md (c), the `revoked` secret-resolution state holds no key on
 *     either side — "Cluster: state-dir file deleted." A WS close with an auth-failure
 *     code (4401 `unauthorized`, 4403 `revoked`) while no pair token is available for
 *     the next attempt means the stored credential is dead: this function deletes it
 *     from the state dir (so it is never resent) and returns the reason for
 *     `tunnel-client.ts` to log distinctly, instead of silently retrying forever with a
 *     credential that can never succeed. The reconnect loop itself keeps running
 *     afterwards, now with no credential and no pair token (the existing "dials and
 *     waits, no crash" behaviour) — so a fresh admin re-pair (a new pair-token file the
 *     operator drops) still redeems with no process restart, matching the plan's "no
 *     service restart" requirement for re-pairing.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { CREDENTIAL_FILENAME, PAIR_TOKEN_FILENAME, deleteStateFile, writeStateFile } from '../state-dir.js';

const BOOTSTRAP_TOKEN_ENV = 'PRIVOS_APP_CLUSTER_BOOTSTRAP_TOKEN';
const BOOTSTRAP_PATH = '/api/v1/app-clusters-pairing.bootstrap';
const BOOTSTRAP_REQUEST_TIMEOUT_MS = 10_000;

export type RepairRequiredReason = 'unauthorized' | 'revoked';

/** Auth-failure WS close codes (wire-contracts.md (a) close-code table) that, absent a pair token to fall back on, signal a dead credential rather than a transient disconnect. */
const REPAIR_REQUIRED_CLOSE_CODES: Record<number, RepairRequiredReason> = {
	4401: 'unauthorized',
	4403: 'revoked',
};

function hmacHex(token: string, message: string): string {
	return createHmac('sha256', token).update(message).digest('hex');
}

function timingSafeEqualHex(expectedHex: string, suppliedHex: string): boolean {
	let expected: Buffer;
	let supplied: Buffer;
	try {
		expected = Buffer.from(expectedHex, 'hex');
		supplied = Buffer.from(suppliedHex, 'hex');
	} catch {
		return false;
	}
	if (expected.length === 0 || expected.length !== supplied.length) return false;
	return timingSafeEqual(expected, supplied);
}

/** Reads the community bootstrap token from the environment (mirrors the Hub's own `readBootstrapToken`). `undefined` means the community bootstrap path is inactive — admin-initiated pairing is unaffected. Not part of `config.ts`'s validated schema, same as the Hub side reads its env var directly rather than through a shared config object. */
export function readBootstrapTokenFromEnv(): string | undefined {
	const raw = process.env[BOOTSTRAP_TOKEN_ENV];
	const trimmed = raw?.trim();
	return trimmed || undefined;
}

const BootstrapSuccessSchema = z.object({
	ok: z.literal(true),
	clusterId: z.string(),
	hubNonce: z.string(),
	hubProof: z.string(),
	token: z.string(),
	expiresAt: z.number(),
});
const BootstrapFailureSchema = z.object({ ok: z.literal(false), reason: z.string() });
const BootstrapResponseSchema = z.union([BootstrapSuccessSchema, BootstrapFailureSchema]);

export interface BootstrapFetchResponse {
	json(): Promise<unknown>;
}
/** Minimal fetch surface this module needs — real `fetch` and test fakes both satisfy it. */
export type BootstrapFetchFn = (url: string, init: RequestInit) => Promise<BootstrapFetchResponse>;

export interface RunCommunityBootstrapOptions {
	hubUrl: string;
	bootstrapToken: string;
	stateDir: string;
	/** Injectable for tests — no test opens a real network connection. Defaults to the real global `fetch`. */
	fetchImpl?: BootstrapFetchFn;
	/** Injectable for deterministic tests; defaults to a fresh random hex nonce. */
	nonce?: () => string;
}

export type BootstrapOutcome = { ok: true; clusterId: string; expiresAt: number } | { ok: false; reason: string };

/**
 * Runs the community bootstrap mutual-HMAC challenge once. Never throws — every
 * failure path (not configured, network error, malformed body, a Hub-reported
 * `ok:false`, or a Hub that cannot answer the challenge) resolves `{ok:false, reason}`
 * and writes nothing to the state dir. Only a verified `hubProof` results in the
 * redeemed pair token being persisted.
 */
export async function runCommunityBootstrap(options: RunCommunityBootstrapOptions): Promise<BootstrapOutcome> {
	const { hubUrl, bootstrapToken, stateDir } = options;
	const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<BootstrapFetchResponse>);
	const nonce = options.nonce ?? (() => randomBytes(16).toString('hex'));

	if (!bootstrapToken.trim()) return { ok: false, reason: 'not_configured' };

	const clusterNonce = nonce();
	const clusterProof = hmacHex(bootstrapToken, `client:${clusterNonce}`);

	let response: BootstrapFetchResponse;
	try {
		const url = new URL(BOOTSTRAP_PATH, hubUrl).toString();
		response = await fetchImpl(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ clusterNonce, clusterProof }),
			signal: AbortSignal.timeout(BOOTSTRAP_REQUEST_TIMEOUT_MS),
		});
	} catch {
		return { ok: false, reason: 'request_failed' };
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { ok: false, reason: 'invalid_response' };
	}

	const parsed = BootstrapResponseSchema.safeParse(body);
	if (!parsed.success) return { ok: false, reason: 'invalid_response' };
	if (!parsed.data.ok) return { ok: false, reason: parsed.data.reason };

	const { clusterId, hubNonce, hubProof, token, expiresAt } = parsed.data;
	const expectedHubProof = hmacHex(bootstrapToken, `hub:${clusterNonce}:${hubNonce}`);
	if (!timingSafeEqualHex(expectedHubProof, hubProof)) {
		// The peer could not answer the challenge — abort before accepting any credential.
		return { ok: false, reason: 'invalid_hub_proof' };
	}

	writeStateFile(stateDir, PAIR_TOKEN_FILENAME, token);
	return { ok: true, clusterId, expiresAt };
}

/**
 * See module doc for the full contract. Returns the terminal reason (and deletes the
 * dead credential from the state dir as a side effect) when `code` is an auth-failure
 * close and no pair token exists to retry with next attempt; otherwise `undefined` (an
 * ordinary transient close — the caller keeps retrying with what it already has).
 */
export function handleRepairRequiredClose(stateDir: string, code: number, hasPairToken: boolean): RepairRequiredReason | undefined {
	if (hasPairToken) return undefined;
	const reason = REPAIR_REQUIRED_CLOSE_CODES[code];
	if (!reason) return undefined;
	deleteStateFile(stateDir, CREDENTIAL_FILENAME);
	return reason;
}
