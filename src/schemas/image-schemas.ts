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

export const ImageIdParamSchema = z.object({
	imageId: z.string().uuid(),
});

export const ListImagesQuerySchema = z.object({
	source: z.enum(['pulled', 'built', 'registered']).optional(),
	mine: z
		.string()
		.optional()
		.transform((v) => v === 'true' || v === '1'),
	q: z.string().max(255).optional(),
});

export const PullImageRequestSchema = z.object({
	repository: RepositorySchema,
	tag: TagSchema.default('latest'),
	description: z.string().max(500).optional(),
});

export const RegisterImageRequestSchema = z.object({
	repository: RepositorySchema,
	tag: TagSchema.default('latest'),
	description: z.string().max(500).optional(),
});

export const TagImageRequestSchema = z.object({
	repository: RepositorySchema,
	tag: TagSchema,
});

export const UpdateImageRequestSchema = z.object({
	description: z.string().max(500).nullable().optional(),
	labels: z.record(z.string(), z.string()).optional(),
});

export const DeleteImageQuerySchema = z.object({
	force: z
		.string()
		.optional()
		.transform((v) => v === 'true' || v === '1'),
});

// Build-related schemas
export const BuildImageRequestSchema = z.object({
	dockerfile: z
		.string()
		.min(10, 'Dockerfile content is too short (minimum 10 characters)')
		.max(100000, 'Dockerfile content is too large (maximum 100KB)'),
	repository: RepositorySchema,
	tag: TagSchema.default('latest'),
	buildArgs: z.record(z.string(), z.string()).optional().default({}),
	description: z.string().max(500).optional(),
});

export const ValidateDockerfileRequestSchema = z.object({
	dockerfile: z
		.string()
		.min(1, 'Dockerfile content is required')
		.max(100000, 'Dockerfile content is too large (maximum 100KB)'),
});

export const BuildIdParamSchema = z.object({
	buildId: z.string().uuid(),
});

export const ListBuildsQuerySchema = z.object({
	status: z.enum(['pending', 'running', 'completed', 'failed']).optional(),
	limit: z
		.string()
		.optional()
		.transform((v) => (v ? parseInt(v, 10) : 20))
		.pipe(z.number().min(1).max(100)),
});
