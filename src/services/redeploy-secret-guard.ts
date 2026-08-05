/**
 * The raw redeploy paths reconstruct a container's environment from its
 * `privos.env` label, which deliberately excludes operator secrets. Rebuilding
 * such a container that way would silently restart it with its secrets missing
 * — a quiet outage that looks like an app bug — so those containers are refused
 * here. A v3 runtime changes configuration only through the signed reconfigure
 * command, which carries the full environment.
 */
export function assertRawRedeployAllowedForLabels(labels: Record<string, string>): void {
	const secretKeys = labels['privos.env.secret-keys'];
	if (labels['privos.mcp.schema'] !== '3' && (!secretKeys || secretKeys === '[]')) return;
	const error: Error & { statusCode?: number } = new Error(
		'This container holds operator secrets; redeploy it through its own lifecycle instead',
	);
	error.statusCode = 409;
	throw error;
}
