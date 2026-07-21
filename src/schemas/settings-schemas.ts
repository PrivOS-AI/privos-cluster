import { z } from 'zod';

// DNS hostname (without scheme). Allows multi-label hosts up to 253 chars total.
// Kept for potential future domain-shape validation even though it's currently unused.
export const HostnameSchema = z
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
