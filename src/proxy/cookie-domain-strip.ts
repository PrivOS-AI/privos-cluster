/**
 * `privos.link` is not yet in the Public Suffix List, so browsers treat every
 * `*.privos.link` host as one cookie-writable origin family: a cookie an app
 * sets with `Domain=privos.link` (or any subdomain of it) would be readable
 * by every OTHER app's `*.privos.link` host too. Until the PSL listing ships,
 * the runtime listener strips that `Domain` attribute from every Set-Cookie
 * response header so a cookie stays scoped to the one host that set it.
 */

const DOMAIN_ATTRIBUTE = /;\s*domain\s*=\s*([^;]*)/i;

function targetsPrivosLink(rawValue: string): boolean {
	const normalized = rawValue.trim().replace(/^\./, '').toLowerCase();
	return normalized === 'privos.link' || normalized.endsWith('.privos.link');
}

/** Strips a `Domain=privos.link`-family attribute from a single Set-Cookie value. */
export function stripPrivosLinkCookieDomain(setCookieValue: string): string {
	const match = DOMAIN_ATTRIBUTE.exec(setCookieValue);
	if (!match || !targetsPrivosLink(match[1])) return setCookieValue;
	return (setCookieValue.slice(0, match.index) + setCookieValue.slice(match.index + match[0].length)).trim();
}

/** Same, over the full (possibly multi-value) Set-Cookie response header. */
export function stripPrivosLinkCookieDomains(setCookieValues: string[]): string[] {
	return setCookieValues.map(stripPrivosLinkCookieDomain);
}
