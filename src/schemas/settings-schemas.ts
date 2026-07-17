import { z } from 'zod';
import { SETTING_KEYS } from '../services/settings-service.js';

// DNS hostname (without scheme). Allows multi-label hosts up to 253 chars total.
const HostnameSchema = z
	.string()
	.trim()
	.max(253)
	.regex(
		/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/,
		'must be a valid lowercase hostname',
	);

// Single DNS label, e.g. "my-app". 1–63 chars, no dots.
export const SubdomainLabelSchema = z
	.string()
	.trim()
	.min(1)
	.max(63)
	.regex(
		/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
		'subdomain must be a lowercase DNS label (a-z, 0-9, dash, 1-63 chars, no leading/trailing dash)',
	);

const DefaultResourcesSchema = z.object({
	memoryMb: z.number().int().min(64).max(8192),
	cpus: z.number().min(0.1).max(16),
	tmpSizeMb: z.number().int().min(16).max(2048),
});

// Per-key validator. Unknown keys are accepted as opaque JSON so admins can
// extend the store without code changes; known keys get strict shape enforcement.
export const SettingValueByKey: Record<string, z.ZodTypeAny> = {
	[SETTING_KEYS.REVERSE_PROXY_BASE_DOMAIN]: z.union([HostnameSchema, z.literal('')]),
	[SETTING_KEYS.REVERSE_PROXY_DOMAINS]: z.array(HostnameSchema).max(50),
	[SETTING_KEYS.REVERSE_PROXY_ENABLED]: z.boolean(),
	[SETTING_KEYS.DEFAULT_RESOURCES]: DefaultResourcesSchema,
	[SETTING_KEYS.MAX_MEMORY_MB_TOTAL]: z.number().int().positive().nullable(),
	[SETTING_KEYS.MAX_CPUS_TOTAL]: z.number().positive().nullable(),
	[SETTING_KEYS.IMAGE_REGISTRY_ALLOWLIST]: z.array(HostnameSchema).max(100),
};

export const SettingKeyParamSchema = z.object({
	key: z
		.string()
		.min(1)
		.max(120)
		.regex(/^[a-z0-9._-]+$/i, 'key must be alphanumeric + . _ -'),
});

export const PutSettingBodySchema = z.object({
	value: z.unknown(),
});

export const PatchSettingsBodySchema = z.record(z.string(), z.unknown());

export function validateSettingValue(key: string, value: unknown): z.SafeParseReturnType<unknown, unknown> {
	const validator = SettingValueByKey[key];
	if (!validator) return z.unknown().safeParse(value);
	return validator.safeParse(value);
}
