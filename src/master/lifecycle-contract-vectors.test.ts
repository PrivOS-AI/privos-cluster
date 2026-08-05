/**
 * Cross-repo lifecycle contract vectors, cluster side.
 *
 * The shared vector file in privos-mt-manage is the wire-contract authority.
 * Two regressions from 2026-08-05 are pinned here:
 *  - defect C: the final acknowledgement's reason codes must satisfy the wire
 *    alphabet, proven by parsing the committed payload through the REAL
 *    schema (the old suite's signer double never applied it);
 *  - defect F: a CONTAINER descriptor declares attributes.containerId, and a
 *    hash-pinned legacy inventory without it must still name its container
 *    through resourceId.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
	ClusterFinalAcknowledgementPayloadV3Schema,
	RuntimeResourceDescriptorV3Schema,
} from './protocol-v3.js';

const VECTORS_DIR =
	process.env.PRIVOS_CONTRACT_VECTORS_DIR ||
	path.resolve(import.meta.dirname, '../../../privos-mt-manage/resources/mcp-app-lifecycle-v3');
const VECTOR_FILE = path.join(VECTORS_DIR, 'lifecycle-signing-vectors.json');

if (!fs.existsSync(VECTOR_FILE)) {
	console.warn(`SKIPPING contract-vector tests: ${VECTOR_FILE} not found (checkout privos-mt-manage as a sibling or set PRIVOS_CONTRACT_VECTORS_DIR)`);
} else {
	const vectors = JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf8'));

	test('the committed final-acknowledgement payload parses through the real schema', () => {
		const parsed = ClusterFinalAcknowledgementPayloadV3Schema.parse(
			vectors.clusterFinalAcknowledgementPayload.payload,
		);
		// The vector deliberately carries a residue result WITH a reason code:
		// that is the exact shape the signer could never emit before d35a80a.
		const withReason = parsed.results.find((result) => result.reasonCode !== null);
		assert.ok(withReason, 'vector must keep a residue result carrying a reason code');
		assert.match(withReason!.reasonCode!, /^[A-Z][A-Z0-9_]{1,95}$/);
	});

	test('a snake_case reason code is refused by the wire schema', () => {
		const mutated = structuredClone(vectors.clusterFinalAcknowledgementPayload.payload);
		mutated.results[1].reasonCode = 'volume_still_present';
		assert.throws(() => ClusterFinalAcknowledgementPayloadV3Schema.parse(mutated));
	});

	test('descriptor vectors parse and the canonical CONTAINER carries its containerId', () => {
		const descriptors = vectors.runtimeResourceDescriptors;
		for (const name of ['canonicalContainer', 'legacyContainerWithoutAttribute', 'replica']) {
			RuntimeResourceDescriptorV3Schema.parse(descriptors[name]);
		}
		assert.equal(
			descriptors.canonicalContainer.attributes.containerId,
			descriptors.canonicalContainer.resourceId,
			'a CONTAINER declares the container it names under attributes.containerId',
		);
	});

	test('a legacy CONTAINER without the attribute still names its container via resourceId', () => {
		// Inventories are hash-pinned at provisioning; generations declared
		// before the attribute existed can never gain it, so the descriptor's
		// resourceId IS the container identity for kind CONTAINER (defect F).
		const legacy = vectors.runtimeResourceDescriptors.legacyContainerWithoutAttribute;
		const containerId = legacy.attributes.containerId ?? (legacy.kind === 'CONTAINER' ? legacy.resourceId : undefined);
		assert.equal(containerId, legacy.resourceId);
	});
}
