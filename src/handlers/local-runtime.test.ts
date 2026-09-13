/**
 * Cross-repo timing-invariant vector, cluster side.
 *
 * The shared `timeouts.json` in privos-mt-manage is the timing-contract
 * authority: `READY_TIMEOUT_SECONDS` here must equal its
 * `clusterReadyTimeoutSeconds`, and the Hub's driver-ACTIVATE timeout must
 * stay comfortably above the cluster's own readiness wait — otherwise a
 * timed-out Hub ACTIVATE that the cluster later completes anyway wedges the
 * portal generation past the supersede fence (the failure mode this
 * invariant exists to catch).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const VECTORS_DIR =
	process.env.PRIVOS_CONTRACT_VECTORS_DIR ||
	path.resolve(import.meta.dirname, '../../../privos-mt-manage/resources/mcp-app-lifecycle-v3');
const TIMEOUTS_FILE = path.join(VECTORS_DIR, 'timeouts.json');

if (!fs.existsSync(TIMEOUTS_FILE)) {
	console.warn(`SKIPPING timing-invariant test: ${TIMEOUTS_FILE} not found (checkout privos-mt-manage as a sibling or set PRIVOS_CONTRACT_VECTORS_DIR)`);
} else {
	const timeouts = JSON.parse(fs.readFileSync(TIMEOUTS_FILE, 'utf8')) as {
		clusterReadyTimeoutSeconds: number;
		activateOverheadSeconds: number;
		hubDriverActivateTimeoutMs: number;
	};

	test('READY_TIMEOUT_SECONDS matches the shared clusterReadyTimeoutSeconds vector', async () => {
		const { READY_TIMEOUT_SECONDS } = await import('./local-runtime.js');
		assert.equal(READY_TIMEOUT_SECONDS, timeouts.clusterReadyTimeoutSeconds);
	});

	test('the Hub driver-ACTIVATE timeout stays above the cluster readiness wait plus overhead', () => {
		assert.ok(
			timeouts.hubDriverActivateTimeoutMs > (timeouts.clusterReadyTimeoutSeconds + timeouts.activateOverheadSeconds) * 1000,
			'hubDriverActivateTimeoutMs must exceed (clusterReadyTimeoutSeconds + activateOverheadSeconds) * 1000',
		);
	});
}
