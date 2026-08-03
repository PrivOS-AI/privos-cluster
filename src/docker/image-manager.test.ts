import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Readable } from 'node:stream';

import type Docker from 'dockerode';

import { ImageManager } from './image-manager.js';

describe('ImageManager.pull', () => {
	it('pulls an already pinned image without appending its digest twice', async () => {
		const digest = `sha256:${'a'.repeat(64)}`;
		const repository = '10.88.0.11:5000/marketplace/canary';
		const immutableReference = `${repository}@${digest}`;
		let pulledReference: string | undefined;

		const docker = {
			pull: async (reference: string) => {
				pulledReference = reference;
				return Readable.from([]);
			},
			modem: {
				followProgress: (_stream: NodeJS.ReadableStream, done: (error: Error | null) => void) => done(null),
			},
			getImage: (reference: string) => ({
				inspect: async () => ({
					Id: 'sha256:image-id',
					RepoTags: [],
					RepoDigests: [immutableReference],
					Size: 1,
					Created: new Date(0).toISOString(),
					Config: { Labels: {} },
					reference,
				}),
			}),
		} as unknown as Docker;

		const image = await new ImageManager(docker).pull(immutableReference, 'latest', digest);

		assert.equal(pulledReference, immutableReference);
		assert.equal(image.repoTag, immutableReference);
		assert.equal(image.digest, digest);
	});
});
