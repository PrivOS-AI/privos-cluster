import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveImmutableImageReference } from './image-reference.js';

describe('resolveImmutableImageReference', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const repository = '10.88.0.11:5000/marketplace/canary';

    it('pins an unpinned repository exactly once', () => {
        assert.equal(resolveImmutableImageReference(repository, 'latest', digest), `${repository}@${digest}`);
    });

    it('accepts an already pinned image without duplicating the digest', () => {
        assert.equal(resolveImmutableImageReference(`${repository}@${digest}`, 'latest', digest), `${repository}@${digest}`);
    });

    it('rejects a conflicting repository pin', () => {
        assert.throws(
            () => resolveImmutableImageReference(`${repository}@sha256:${'b'.repeat(64)}`, 'latest', digest),
            /does not match/,
        );
    });
});
