import { z } from 'zod';
import { config } from '../config.js';
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
    workspaceId: z.string().regex(/^[A-Za-z0-9-]+$/).optional(),
    listingId: z.string().min(1).max(128).optional(),
    versionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    image: z.string().min(1, 'image is required'),
    tag: z.string().default('latest'),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/, 'digest must be sha256:<64 lowercase hex>').optional(),
    port: z.number().int().min(1).max(65535).default(3001),
    resources: ResourcesSchema.partial().default({}),
    envVars: z.record(z.string(), z.string()).default({}),
    volumes: z.array(VolumeSchema).max(10).optional(),
    subdomain: SubdomainLabelSchema.nullable().optional(),
    domain: z.string().trim().max(253).nullable().optional(), // base domain to publish under
}).superRefine((value, ctx) => {
    const requiresDigest = config.FLEET_MODE || value.image.split('/').includes('marketplace');
    if (requiresDigest && !value.digest) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['digest'],
            message: config.FLEET_MODE
                ? 'fleet-mode images must be deployed by digest'
                : 'marketplace images must be deployed by digest',
        });
    }
    if (config.FLEET_MODE) {
        for (const field of ['workspaceId', 'listingId', 'versionDigest'] as const) {
            if (!value[field]) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: [field],
                    message: `${field} is required in fleet mode`,
                });
            }
        }
        if (value.volumes && (value.volumes.length > 1 || (value.volumes.length === 1 && value.volumes[0]?.name !== 'data'))) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['volumes'],
                message: 'fleet apps support one optional volume named data',
            });
        }
    }
});

export const RedeployRequestSchema = z.object({
    workspaceId: z.string().regex(/^[A-Za-z0-9-]+$/).optional(),
    image: z.string().optional(),
    tag: z.string().optional(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    versionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    resources: ResourcesSchema.partial().optional(),
    envVars: z.record(z.string(), z.string()).optional(),
    rolling: z.boolean().optional(),
    subdomain: SubdomainLabelSchema.nullable().optional(),
    domain: z.string().trim().max(253).nullable().optional(),
}).superRefine((value, ctx) => {
    const requiresDigest = config.FLEET_MODE || value.image?.split('/').includes('marketplace');
    if (requiresDigest && !value.digest) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['digest'],
            message: config.FLEET_MODE
                ? 'fleet-mode images must be redeployed by digest'
                : 'marketplace images must be redeployed by digest',
        });
    }
    if (config.FLEET_MODE && !value.workspaceId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['workspaceId'],
            message: 'workspaceId is required in fleet mode',
        });
    }
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
