import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stripPrivosLinkCookieDomain, stripPrivosLinkCookieDomains } from './cookie-domain-strip.js';

test('strips Domain=privos.link and a leading-dot subdomain variant', () => {
	assert.equal(
		stripPrivosLinkCookieDomain('sid=abc; Path=/; Domain=privos.link; Secure'),
		'sid=abc; Path=/; Secure',
	);
	assert.equal(
		stripPrivosLinkCookieDomain('sid=abc; Domain=.shop--acme.privos.link'),
		'sid=abc',
	);
	assert.equal(
		stripPrivosLinkCookieDomain('sid=abc; domain=SHOP.PRIVOS.LINK; Path=/'),
		'sid=abc; Path=/',
		'case-insensitive attribute name and value',
	);
});

test('leaves a cookie with no Domain, or a foreign Domain, unchanged', () => {
	assert.equal(stripPrivosLinkCookieDomain('sid=abc; Path=/'), 'sid=abc; Path=/');
	assert.equal(stripPrivosLinkCookieDomain('sid=abc; Domain=example.com'), 'sid=abc; Domain=example.com');
	// A domain that merely CONTAINS the string must not be treated as a suffix match.
	assert.equal(stripPrivosLinkCookieDomain('sid=abc; Domain=notprivos.link'), 'sid=abc; Domain=notprivos.link');
});

test('maps over a multi-value Set-Cookie header', () => {
	assert.deepEqual(
		stripPrivosLinkCookieDomains(['a=1; Domain=privos.link', 'b=2; Domain=example.com']),
		['a=1', 'b=2; Domain=example.com'],
	);
});
