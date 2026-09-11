/**
 * Handles the `{t:'forward', id, runtimeId, path, headers, body}` tunnel
 * frame (wire-contracts.md section (a)) — MCP RPC dispatch to a running
 * local-runtime app container. Replaces the phase-3 `501 not_implemented`
 * stub in `tunnel-client.ts`.
 *
 * The target is resolved by the container's `privos.local-runtime.id` Docker
 * label matching `runtimeId` — a label lookup only, never a caller-supplied
 * address. An unknown `runtimeId` returns 404 without any Docker mutation
 * (the label lookup itself is a read-only `listContainers` call). Bodies are
 * capped and the response is size-bounded the same way the ABI's raw
 * response cap is (`DRIVER_RESPONSE_MAX_BYTES` in
 * `mcp-local-runtime-driver-v3.ts` — 64 KB), reused here for symmetry rather
 * than inventing a second number.
 */
import { request as undiciRequest } from 'undici';
import type Docker from 'dockerode';

/** Matches the Hub's `DRIVER_RESPONSE_MAX_BYTES` (`mcp-local-runtime-driver-v3.ts:10-11`) — reused, not re-derived. */
export const FORWARD_BODY_MAX_BYTES = 64 * 1024;
/** Matches the Hub's `DRIVER_TIMEOUT_MS` default; per-call `timeoutMs` from the frame overrides it. */
export const FORWARD_DEFAULT_TIMEOUT_MS = 30_000;

const LOCAL_RUNTIME_ID_LABEL = 'privos.local-runtime.id';

export interface ForwardRequest {
	runtimeId: string;
	path: string;
	headers?: Record<string, string>;
	body?: unknown;
	timeoutMs?: number;
}

export interface ForwardResponse {
	status: number;
	headers?: Record<string, string>;
	body?: unknown;
	raw?: boolean;
	rawBody?: string;
	error?: { code: string; message: string };
}

/** Injectable HTTP transport so tests never open a real socket. */
export type ForwardTransport = (url: string, init: {
	method: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs: number;
}) => Promise<{ status: number; bodyText: string }>;

const defaultTransport: ForwardTransport = async (url, init) => {
	const response = await undiciRequest(url, {
		method: init.method as 'GET' | 'POST',
		headers: init.headers,
		body: init.body,
		bodyTimeout: init.timeoutMs,
		headersTimeout: init.timeoutMs,
	});
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of response.body) {
		total += (chunk as Buffer).length;
		if (total > FORWARD_BODY_MAX_BYTES) {
			response.body.destroy();
			throw new ForwardResponseTooLarge();
		}
		chunks.push(chunk as Buffer);
	}
	return { status: response.statusCode, bodyText: Buffer.concat(chunks).toString('utf8') };
};

class ForwardResponseTooLarge extends Error {}

/** Resolves the single running container whose `privos.local-runtime.id` label matches — never a caller-supplied address. */
async function findRuntimeContainer(docker: Docker, runtimeId: string): Promise<{ address: string; port: number } | null> {
	const containers = await docker.listContainers({
		all: false,
		filters: { label: [`${LOCAL_RUNTIME_ID_LABEL}=${runtimeId}`] },
	});
	const summary = containers[0] as any;
	if (!summary) return null;
	const networks = summary.NetworkSettings?.Networks ?? {};
	const address = Object.values(networks).map((n: any) => n?.IPAddress).find((ip: unknown) => typeof ip === 'string' && ip);
	const port = (summary.Ports as Array<{ PrivatePort?: number }> | undefined)?.[0]?.PrivatePort;
	if (!address || !port) return null;
	return { address: address as string, port };
}

/**
 * Dispatches one `forward` frame to the container carrying the matching
 * `privos.local-runtime.id` label. Always POSTs (MCP RPC dispatch is POST
 * JSON-RPC, matching `mcp-dispatch.ts`'s `htm: 'POST'` convention) when a
 * body is present, GET otherwise.
 */
export async function dispatchForward(
	docker: Docker,
	input: ForwardRequest,
	transport: ForwardTransport = defaultTransport,
): Promise<ForwardResponse> {
	if (!input.path.startsWith('/')) {
		return { status: 400, error: { code: 'bad_request', message: 'forward path must be absolute' } };
	}
	const bodyText = input.body === undefined ? undefined : JSON.stringify(input.body);
	if (bodyText !== undefined && Buffer.byteLength(bodyText, 'utf8') > FORWARD_BODY_MAX_BYTES) {
		return { status: 413, error: { code: 'payload_too_large', message: 'forward request body exceeds the size cap' } };
	}

	const target = await findRuntimeContainer(docker, input.runtimeId);
	if (!target) {
		return { status: 404, error: { code: 'not_found', message: 'no running local runtime carries this runtimeId' } };
	}

	try {
		const result = await transport(`http://${target.address}:${target.port}${input.path}`, {
			method: bodyText === undefined ? 'GET' : 'POST',
			headers: input.headers,
			body: bodyText,
			timeoutMs: input.timeoutMs ?? FORWARD_DEFAULT_TIMEOUT_MS,
		});
		try {
			return { status: result.status, body: JSON.parse(result.bodyText) };
		} catch {
			return { status: result.status, raw: true, rawBody: result.bodyText };
		}
	} catch (err) {
		if (err instanceof ForwardResponseTooLarge) {
			return { status: 502, error: { code: 'response_too_large', message: 'forward response exceeds the size cap' } };
		}
		return { status: 502, error: { code: 'forward_failed', message: (err as Error).message } };
	}
}
