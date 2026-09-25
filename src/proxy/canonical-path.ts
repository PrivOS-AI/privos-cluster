/**
 * Canonicalizes a raw HTTP request-target (path + query) before the runtime
 * listener resolves it to a container route. Path traversal and encoded
 * slash/backslash tricks must be rejected outright (400) rather than
 * silently normalized away by the WHATWG `URL` parser, so an attacker's
 * intent is never masked as an ordinary lookup miss.
 */

const ENCODED_SLASH_OR_BACKSLASH = /%2f|%5c/i;

export interface CanonicalPath {
	pathname: string;
	search: string;
}

/** Returns `null` when `rawTarget` must be rejected with 400. */
export function canonicalizePath(rawTarget: string): CanonicalPath | null {
	// Checked on the RAW target, before WHATWG parsing: an encoded slash/backslash
	// must never be allowed to smuggle an extra path segment past the matcher below.
	if (ENCODED_SLASH_OR_BACKSLASH.test(rawTarget)) return null;

	// Also checked on the RAW path, before WHATWG parsing: `URL` silently resolves
	// `.`/`..` segments away (so a post-parse check on `pathname` never sees them)
	// and treats a leading `//` as a network-path reference that hijacks the host —
	// both must be rejected outright rather than let the parser normalize past them.
	const rawPath = rawTarget.split(/[?#]/, 1)[0];
	if (!rawPath.startsWith('/') || rawPath.startsWith('//')) return null;
	if (rawPath.includes('//')) return null;
	if (rawPath.split('/').some((segment) => segment === '.' || segment === '..')) return null;

	let url: URL;
	try {
		url = new URL(rawTarget, 'http://placeholder.invalid');
	} catch {
		return null;
	}
	if (url.host !== 'placeholder.invalid') return null; // defense in depth — raw target smuggled a different authority

	const { pathname, search } = url;
	if (!pathname.startsWith('/') || pathname.includes('//')) return null; // `//` — including a leading double slash

	return { pathname, search };
}

export interface PathRoute<T> {
	prefix: string;
	value: T;
}

/**
 * `prefix` matches `pathname` on a segment boundary: exact equality, `prefix`
 * is the root `/`, or `pathname` continues with a `/` right after `prefix` —
 * so a route for `/api` never matches `/apikeys`.
 */
function prefixMatches(prefix: string, pathname: string): boolean {
	if (prefix === '/' || prefix === pathname) return true;
	return pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

/**
 * Picks the matching route with the longest prefix (most specific wins).
 * `undefined` means no route matched — the caller sends 404.
 */
export function matchLongestPrefix<T>(pathname: string, routes: Array<PathRoute<T>>): T | undefined {
	let best: PathRoute<T> | undefined;
	for (const route of routes) {
		if (!prefixMatches(route.prefix, pathname)) continue;
		if (!best || route.prefix.length > best.prefix.length) best = route;
	}
	return best?.value;
}
