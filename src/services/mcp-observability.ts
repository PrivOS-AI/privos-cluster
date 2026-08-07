import crypto from 'node:crypto';
import pino from 'pino';

export type ClusterMcpOutcome = 'allowed' | 'denied' | 'changed' | 'observed';
export type ClusterMcpMetric = Readonly<{
	event: string;
	outcome: ClusterMcpOutcome;
	boundary: string;
	reason: string;
	count: number;
}>;

// This module is shared by the fleet agent and the independently configured
// master. Reading the agent config here would make a master process validate
// unrelated agent-only requirements during module import.
const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
const requestedLogLevel = process.env.LOG_LEVEL ?? 'info';
const logger = pino({ level: LOG_LEVELS.has(requestedLogLevel) ? requestedLogLevel : 'info' })
	.child({ component: 'mcp-security' });
const counters = new Map<string, number>();
// Minimum length 2: callers that upper-case this into a signed acknowledgement
// errorCode (e.g. the upgrade and reconfigure routes) feed it into
// `SafeReasonCode` (`^[A-Z][A-Z0-9_]{1,95}$`, minimum length 2). A 1-char
// error message (or a value that reduces to one after lower-casing) must fall
// back here rather than pass through and fail that later, unhandled, `.parse()`.
const SAFE_CODE = /^[a-z][a-z0-9_]{1,63}$/;

function safeCode(value: unknown, fallback: string): string {
	const candidate = typeof value === 'string' ? value.toLowerCase() : '';
	return SAFE_CODE.test(candidate) ? candidate : fallback;
}

export function clusterMcpSafeReason(error: unknown, fallback = 'internal_error'): string {
	return safeCode(error instanceof Error ? error.message : error, fallback);
}

function opaqueCorrelation(value: string | undefined): string | undefined {
	return value ? crypto.createHash('sha256').update(value).digest('hex').slice(0, 16) : undefined;
}

/** Aggregate-only security telemetry; never accepts request bodies or artifacts. */
export function recordClusterMcpEvent(input: {
	event: string;
	outcome: ClusterMcpOutcome;
	boundary?: string;
	reason?: string;
	correlationId?: string;
	emitLog?: boolean;
}): void {
	const event = safeCode(input.event, 'unknown_event');
	const boundary = safeCode(input.boundary, 'unspecified');
	const reason = safeCode(input.reason, input.outcome === 'allowed' ? 'ok' : 'unspecified');
	const key = [event, input.outcome, boundary, reason].join('|');
	const count = (counters.get(key) ?? 0) + 1;
	counters.set(key, count);
	if (input.emitLog === false) return;
	logger.info({ event, outcome: input.outcome, boundary, reason, count, correlation: opaqueCorrelation(input.correlationId) }, 'MCP security event');
}

export function getClusterMcpMetrics(): ClusterMcpMetric[] {
	return [...counters.entries()]
		.map(([key, count]) => {
			const [event, outcome, boundary, reason] = key.split('|');
			return { event: event!, outcome: outcome as ClusterMcpOutcome, boundary: boundary!, reason: reason!, count };
		})
		.sort((left, right) => `${left.event}|${left.outcome}|${left.boundary}|${left.reason}`.localeCompare(`${right.event}|${right.outcome}|${right.boundary}|${right.reason}`));
}

export function resetClusterMcpMetricsForTests(): void {
	counters.clear();
}
