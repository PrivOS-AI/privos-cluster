import { z } from 'zod';
import type { JsonWebKey } from 'node:crypto';
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

/** Operator-declarable environment name. Upper snake, never the PRIVOS_ namespace. */
export const EnvNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

/** The exact platform-injected names. Anything else is a spoofing attempt. */
export const PLATFORM_ENV_NAMES = ['PRIVOS_PUBLIC_URL', 'PRIVOS_ACCESS_MODE'] as const;
export const PlatformEnvNameSchema = z.enum(PLATFORM_ENV_NAMES);

const DeployRequestObject = z.object({
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
    // Platform-injected names live in their own map: `envVars` refuses the
    // PRIVOS_ namespace precisely so a Hub-supplied value can never impersonate
    // one of these.
    platformEnvVars: z.record(PlatformEnvNameSchema, z.string().max(4096)).default({}),
    // Names inside `envVars` whose values are operator secrets. They still reach
    // the container process environment; they never reach a Docker label.
    secretEnvKeys: z.array(EnvNameSchema).max(32).default([]),
    volumes: z.array(VolumeSchema).max(10).optional(),
    subdomain: SubdomainLabelSchema.nullable().optional(),
    domain: z.string().trim().max(253).nullable().optional(), // base domain to publish under
    // The master spreads its own deploy input into every agent dispatch, and that
    // input carries the placement decision. The agent receives one replica at a
    // time, so these are informational here — accepted so the strict schema does
    // not reject the master's payload, and otherwise ignored.
    availabilityTier: z.enum(['single', 'ha']).optional(),
    stateless: z.boolean().optional(),
});

function validateDeployRequest(value: z.infer<typeof DeployRequestObject>, ctx: z.RefinementCtx): void {
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
}

export const DeployRequestSchema = DeployRequestObject.superRefine(validateDeployRequest);

const PublicP256JwkSchema = z.object({
	kty: z.literal('EC'),
	crv: z.literal('P-256'),
	x: z.string().min(1),
	y: z.string().min(1),
	kid: z.string().optional(),
	use: z.string().optional(),
	key_ops: z.array(z.string()).optional(),
	alg: z.string().optional(),
}).strict().transform((value) => value as JsonWebKey);

export const McpRuntimeBindingSchema = z.object({
	clusterId: z.string().regex(/^[A-Za-z0-9-]+$/),
	nodeId: z.string().regex(/^[A-Za-z0-9-]+$/),
	workspaceId: z.string().regex(/^[A-Za-z0-9-]+$/),
	installationId: z.string().min(1).max(128),
	mcpAppId: z.string().min(1).max(128),
	replicaId: z.string().uuid(),
	imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	receiptHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	grantEpoch: z.number().int().positive(),
	deploymentGrantHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	hubOrigin: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'hubOrigin must use HTTPS'),
	hubKid: z.string().min(20).max(128),
	hubPublicJwk: PublicP256JwkSchema,
}).strict();

export const McpDeployRequestSchema = DeployRequestObject.extend({ mcpBinding: McpRuntimeBindingSchema }).superRefine((value, ctx) => {
		validateDeployRequest(value, ctx);
		for (const key of Object.keys(value.envVars ?? {})) {
			if (key.toUpperCase().startsWith('PRIVOS_')) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['envVars', key],
					message: 'PRIVOS_* environment names are reserved for the platform',
				});
			}
		}
		if (value.workspaceId !== value.mcpBinding.workspaceId) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workspaceId'], message: 'workspace binding mismatch' });
		}
		if (value.digest !== value.mcpBinding.imageDigest) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['digest'], message: 'image digest binding mismatch' });
		}
	});

export const McpRuntimeProvisioningBindingV3Schema = z.object({
	protocolVersion: z.literal(3),
	clusterId: z.string().regex(/^[A-Za-z0-9-]+$/),
	nodeId: z.string().regex(/^[A-Za-z0-9-]+$/),
	workspaceId: z.string().min(1).max(160),
	deploymentId: z.string().min(1).max(160),
	generationId: z.string().min(1).max(160),
	generationNumber: z.number().int().positive(),
	runtimeInstallationId: z.string().min(1).max(160),
	mcpAppId: z.string().min(1).max(160),
	replicaId: z.string().uuid(),
	containerId: z.string().uuid(),
	imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	approvalReceiptHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	authorizationEpoch: z.number().int().positive(),
	deploymentGrantHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	resourceManifestHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	hubOrigin: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'hubOrigin must use HTTPS'),
	hubKid: z.string().min(20).max(128),
	hubPublicJwk: PublicP256JwkSchema,
}).strict();

export const McpDeployRequestV3Schema = DeployRequestObject.extend({
	mcpV3Binding: McpRuntimeProvisioningBindingV3Schema,
}).strict().superRefine((value, ctx) => {
	validateDeployRequest(value, ctx);
	if (!value.appId) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['appId'], message: 'appId is required for MCP v3' });
	}
	for (const key of Object.keys(value.envVars ?? {})) {
		if (key.toUpperCase().startsWith('PRIVOS_')) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['envVars', key],
				message: 'PRIVOS_* environment names are reserved for the platform',
			});
		}
	}
	if (value.workspaceId !== value.mcpV3Binding.workspaceId) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workspaceId'], message: 'workspace binding mismatch' });
	}
	if (value.digest !== value.mcpV3Binding.imageDigest) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['digest'], message: 'image digest binding mismatch' });
	}
	validateSecretEnvKeys(value, ctx);
});

/**
 * A secret name that does not exist in `envVars` would silently drop out of the
 * label-exclusion set on the next recreate and leak the value into `privos.env`.
 */
function validateSecretEnvKeys(
	value: { envVars?: Record<string, string>; secretEnvKeys?: string[] },
	ctx: z.RefinementCtx,
): void {
	const declared = new Set(Object.keys(value.envVars ?? {}));
	for (const key of value.secretEnvKeys ?? []) {
		if (!declared.has(key)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['secretEnvKeys', key],
				message: 'secret names must exist in envVars',
			});
		}
	}
}

/**
 * Configuration-only recreate of one already-provisioned v3 replica. Image,
 * version, resources, and every binding claim are carried so the agent can
 * refuse a request that does not match the container it already holds; only the
 * environment is allowed to differ.
 */
export const McpRuntimeReconfigureBindingV3Schema = McpRuntimeProvisioningBindingV3Schema.omit({
	// The Hub identity a generation was provisioned under is immutable and
	// already on the container's labels; the agent reuses it rather than letting
	// a reconfigure request restate — and therefore be able to swap — the key
	// that authorizes every dispatch into this app.
	hubOrigin: true,
	hubKid: true,
	hubPublicJwk: true,
});

export const McpReconfigureRequestV3Schema = DeployRequestObject.extend({
	mcpV3Binding: McpRuntimeReconfigureBindingV3Schema,
	configEpoch: z.number().int().positive(),
	runtimeResourceInventoryHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict().superRefine((value, ctx) => {
	validateDeployRequest(value, ctx);
	if (!value.appId) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['appId'], message: 'appId is required for MCP v3' });
	}
	for (const key of Object.keys(value.envVars ?? {})) {
		if (key.toUpperCase().startsWith('PRIVOS_')) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['envVars', key],
				message: 'PRIVOS_* environment names are reserved for the platform',
			});
		}
	}
	if (value.workspaceId !== value.mcpV3Binding.workspaceId) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workspaceId'], message: 'workspace binding mismatch' });
	}
	if (value.digest !== value.mcpV3Binding.imageDigest) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['digest'], message: 'image digest binding mismatch' });
	}
	validateSecretEnvKeys(value, ctx);
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

/**
 * Backend-only human credential carried beside (never inside) the signed RPC.
 * The Master and Agent deliberately treat the compact JWT as opaque; this
 * schema only makes the rolling wire member atomic and safe to convert into
 * HTTP headers after the Agent has verified the dispatch assertion.
 */
export const CallerCredentialSchema = z.object({
	token: z.string()
		.min(1)
		.max(32_768)
		.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'token must be a compact JWT'),
	assertedUserId: z.string()
		.min(1)
		.max(160)
		.regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/, 'assertedUserId contains unsafe characters'),
}).strict();

export const McpDispatchBodySchema = z.object({
	assertion: z.string().min(1),
	rpc: DispatchBodySchema,
}).strict();

export const McpDispatchBodyV3Schema = z.discriminatedUnion('authorizationContext', [
	z.object({
		assertion: z.string().min(1),
		rpc: DispatchBodySchema,
		authorizationContext: z.literal('workspace'),
		runtimeInstallationId: z.string().min(1).max(160),
		runtimeResourceInventoryHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
		callerCredential: CallerCredentialSchema.optional(),
	}).strict(),
	z.object({
		assertion: z.string().min(1),
		rpc: DispatchBodySchema,
		authorizationContext: z.literal('room'),
		runtimeInstallationId: z.string().min(1).max(160),
		authorizationBindingId: z.string().min(1).max(160),
		runtimeResourceInventoryHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
		callerCredential: CallerCredentialSchema.optional(),
	}).strict(),
]);
