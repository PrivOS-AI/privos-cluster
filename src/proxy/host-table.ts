/**
 * Thin, proxy-side read view over the fleet-wide host tables received by
 * `handlers/host-table.ts` (phase 3, already committed). This module adds NO
 * storage of its own — it only shapes the lookups the ingress/runtime
 * listeners need (exact host, signing key by kid, staleness) on top of the
 * one in-memory store `currentHostTables()` already owns.
 */
import { currentHostTables } from '../handlers/host-table.js';

type HostTables = ReturnType<typeof currentHostTables>;
type RuntimeStored = NonNullable<HostTables['runtimeTable']>;
type IngressStored = NonNullable<HostTables['ingressTable']>;

export type RuntimeApp = RuntimeStored['table'][number];
export type IngressRule = IngressStored['table']['rules'][number];
export type SigningKey = IngressStored['table']['signingKeys'][number];

/** The runtime app whose `hosts` includes this exact host, if any. */
export function findRuntimeAppByHost(host: string): RuntimeApp | undefined {
	return currentHostTables().runtimeTable?.table.find((app) => app.hosts.includes(host));
}

/** Exact-host lookup only — the ingress listener never falls back to `splitHost`. */
export function findIngressRuleByHost(host: string): IngressRule | undefined {
	return currentHostTables().ingressTable?.table.rules.find((rule) => rule.host === host);
}

export function findSigningKey(kid: string): SigningKey | undefined {
	return currentHostTables().ingressTable?.table.signingKeys.find((key) => key.kid === kid);
}

/** Age of the ingress table in ms, or `null` when no push has ever landed. */
export function ingressTableAgeMs(now: number): number | null {
	const table = currentHostTables().ingressTable;
	return table ? now - new Date(table.receivedAt).getTime() : null;
}
