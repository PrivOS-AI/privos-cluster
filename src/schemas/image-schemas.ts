import { z } from 'zod';

// Docker repository names: lowercase, may contain digits, dots, dashes, slashes,
// and a registry host prefix like ghcr.io/. Keep the regex permissive but reject
// whitespace and obviously-bad chars.
const RepositorySchema = z
	.string()
	.min(1, 'repository is required')
	.max(255)
	.regex(/^[a-z0-9._\-/:]+$/i, 'repository contains invalid characters');

const TagSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._-]+$/, 'tag must be alphanumeric + . _ -');

export const ListImagesQuerySchema = z.object({
	q: z.string().max(255).optional(),
});

export const PullImageRequestSchema = z.object({
	repository: RepositorySchema,
	tag: TagSchema.default('latest'),
});
