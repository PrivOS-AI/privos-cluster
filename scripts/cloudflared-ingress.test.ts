import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderCloudflaredIngress, renderDnsRouteCommands, mergeEnv } from './cloudflared-ingress.js';

test('renderCloudflaredIngress emits one wildcard per domain + a 404 catch-all', () => {
	assert.equal(
		renderCloudflaredIngress(['privos.link'], 8080),
		[
			'ingress:',
			'  - hostname: "*.privos.link"',
			'    service: http://localhost:8080',
			'  - service: http_status:404',
		].join('\n'),
	);

	const multi = renderCloudflaredIngress(['privos.link', ' apps.example.com '], 9000);
	assert.match(multi, /hostname: "\*\.privos\.link"/);
	assert.match(multi, /hostname: "\*\.apps\.example\.com"/);
	assert.match(multi, /service: http:\/\/localhost:9000/);
	assert.match(multi, /- service: http_status:404$/);
});

test('renderDnsRouteCommands emits one route command per domain', () => {
	assert.equal(
		renderDnsRouteCommands(['privos.link', 'apps.example.com'], 'my-tunnel'),
		'cloudflared tunnel route dns my-tunnel "*.privos.link"\n' +
			'cloudflared tunnel route dns my-tunnel "*.apps.example.com"',
	);
});

test('mergeEnv updates existing keys in place and preserves comments/untouched keys', () => {
	const existing = ['# server', 'PORT=4000', 'REVERSE_PROXY_MODE=caddy', '', '# other', 'CORS_ORIGIN='].join('\n');
	const merged = mergeEnv(existing, { REVERSE_PROXY_MODE: 'native', PROXY_PORT: '8080' });

	assert.match(merged, /^# server$/m);
	assert.match(merged, /^PORT=4000$/m); // untouched
	assert.match(merged, /^REVERSE_PROXY_MODE=native$/m); // updated in place
	assert.doesNotMatch(merged, /REVERSE_PROXY_MODE=caddy/); // no duplicate
	assert.match(merged, /^# other$/m); // comment preserved
	assert.match(merged, /^PROXY_PORT=8080$/m); // new key appended
});

test('mergeEnv is idempotent — re-applying the same updates is a no-op', () => {
	const base = 'PORT=4000\nREVERSE_PROXY_MODE=caddy';
	const first = mergeEnv(base, { REVERSE_PROXY_MODE: 'native' });
	const second = mergeEnv(first, { REVERSE_PROXY_MODE: 'native' });
	assert.equal(first, second);
});

test('mergeEnv appends into an empty file', () => {
	assert.equal(mergeEnv('', { JWT_SECRET: 'abc', PROXY_PORT: '8080' }), 'JWT_SECRET=abc\nPROXY_PORT=8080');
});
