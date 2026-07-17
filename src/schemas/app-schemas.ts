import { z } from 'zod';
import { SubdomainLabelSchema } from './settings-schemas.js';

export const ResourcesSchema = z.object({
    memoryMb: z.number().int().min(64).max(2048).default(256),
    cpus: z.number().min(0.1).max(4).default(0.5),
    tmpSizeMb: z.number().int().min(16).max(1024).default(64),
});

export const VolumeSchema = z.object({
    name: z.string().regex(/^[a-z0-9-]{1,32}$/, 'volume name must be lowercase alphanumeric/dash, 1-32 chars'),
    mountPath: z.string().regex(/^\/[\w/.-]*$/, 'mountPath must be an absolute path').max(200),
    sizeMb: z.number().int().min(1).max(10240).optional(),
});

export const DeployRequestSchema = z.object({
    appId: z.string().optional(),
    image: z.string().min(1, 'image is required'),
    tag: z.string().default('latest'),
    port: z.number().int().min(1).max(65535).default(3001),
    resources: ResourcesSchema.partial().default({}),
    envVars: z.record(z.string(), z.string()).default({}),
    volumes: z.array(VolumeSchema).max(10).optional(),
    subdomain: SubdomainLabelSchema.nullable().optional(),
    domain: z.string().trim().max(253).nullable().optional(), // base domain to publish under
});

export const RedeployRequestSchema = z.object({
    image: z.string().optional(),
    tag: z.string().optional(),
    resources: ResourcesSchema.partial().optional(),
    envVars: z.record(z.string(), z.string()).optional(),
    rolling: z.boolean().optional(),
    subdomain: SubdomainLabelSchema.nullable().optional(),
    domain: z.string().trim().max(253).nullable().optional(),
});

export const ContainerIdParamSchema = z.object({
    containerId: z.string().uuid(),
});

export const LogsQuerySchema = z.object({
    tail: z.coerce.number().int().min(1).max(5000).default(100),
    timestamps: z
        .string()
        .optional()
        .transform((v) => v === 'true' || v === '1'),
});

export const FilesQuerySchema = z.object({
    path: z.string().default('/app'),
});

export const FileContentQuerySchema = z.object({
    path: z.string().min(1),
});

export const DispatchBodySchema = z.object({
    jsonrpc: z.string().optional(),
    method: z.string(),
    params: z.unknown().optional(),
    id: z.union([z.string(), z.number()]).optional(),
});
