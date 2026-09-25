/**
 * Nonce replay guard for signed agent-proxy hops (ingress → runtime). A nonce
 * is remembered for `ttlMs`; a repeat within that window is a replay. Expired
 * entries are swept lazily on each check — no timer, no unbounded growth
 * beyond the live window (60s per the phase 5 spec).
 */
export interface ReplayCache {
	/** Returns true the first time `nonce` is seen within the window; false on repeat. */
	checkAndRemember(nonce: string, nowMs: number): boolean;
	size(): number;
}

export function createReplayCache(ttlMs = 60_000): ReplayCache {
	const seenUntil = new Map<string, number>();

	function sweep(nowMs: number): void {
		for (const [nonce, expiresAt] of seenUntil) {
			if (expiresAt <= nowMs) seenUntil.delete(nonce);
		}
	}

	return {
		checkAndRemember(nonce, nowMs) {
			sweep(nowMs);
			if (seenUntil.has(nonce)) return false;
			seenUntil.set(nonce, nowMs + ttlMs);
			return true;
		},
		size() {
			return seenUntil.size;
		},
	};
}
