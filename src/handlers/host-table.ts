import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { JsonWebKey } from 'node:crypto';
import { z } from 'zod';

/**
 * The fleet-wide host-table push (phase-3 F). Unlike every other route in
 * this fleet API, the caller carries no tenant `workspaceId` — see
 * `AgentClient.fleetRequest` / `FLEET_SCOPED_WORKSPACE_ID` on the master —
 * so `fastify.authenticate` alone is not enough: it only proves the token
 * was signed by THIS node's own fleet key, not that it was minted for this
 * fleet-wide route rather than replayed from a tenant-scoped call. The extra
 * `sub`/`workspaceId` check below closes that gap.
 *
 * Storage here is deliberately the simplest thing that cannot lose a push:
 * in-memory, replaced wholesale, gated by `revision` ALONE so a push that
 * raced behind a newer one is dropped rather than applied out of order.
 * `revision` is globally atomic-monotonic because every control node (HA:
 * ctl-eu-01/02/03) shares the same `MASTER_MONGODB_URL` — `apps_master_meta`
 * is one collection, not one per process — so this is correct even with more
 * than one master live at once (control and gen nodes deploy separately and
 * non-atomically, so that is a real, not hypothetical, fleet shape). A
 * random per-boot value (the old `masterEpoch`) has no such order and MUST
 * NEVER gate acceptance — see `bootTimestamp` below, kept for observability
 * only. Wiring the received table into actual container/ingress routing
 * decisions is out of scope for this phase (master-side only) — this
 * handler's job is to receive and durably remember the latest table.
 */
const FLEET_SUB = 'apps-master-fleet';
const FLEET_WORKSPACE_ID = '__fleet__';

const RuntimeTableSchema = z.object({
	/** Observability only — see the module doc. Never used to order acceptance. */
	bootTimestamp: z.number().int().nonnegative(),
	revision: z.number().int().positive(),
	apps: z.array(z.object({
		appId: z.string().min(1),
		workspaceId: z.string().min(1),
		containerId: z.string().min(1),
		hosts: z.array(z.string()),
	})),
}).strict();

const IngressTableSchema = z.object({
	bootTimestamp: z.number().int().nonnegative(),
	revision: z.number().int().positive(),
	rules: z.array(z.object({
		host: z.string().min(1),
		appId: z.string().min(1),
		workspaceId: z.string().min(1),
		nodes: z.array(z.string()),
		suspended: z.boolean(),
	})),
	signingKeys: z.array(z.object({
		nodeId: z.string().min(1),
		kid: z.string().min(1),
		publicJwk: z.record(z.string(), z.unknown()),
	})),
}).strict();

interface StoredTable<T> {
	bootTimestamp: number;
	revision: number;
	receivedAt: string;
	table: T;
}

let runtimeTable: StoredTable<z.infer<typeof RuntimeTableSchema>['apps']> | undefined;
let ingressTable: StoredTable<{ rules: z.infer<typeof IngressTableSchema>['rules']; signingKeys: Array<{ nodeId: string; kid: string; publicJwk: JsonWebKey }> }> | undefined;

/**
 * Newer wins on `revision` ALONE. This is not a simplification of a
 * two-field tiebreak — a second field is actively wrong here: `revision` is
 * already a total, globally monotonic order (shared Mongo, see the module
 * doc), so anything else that could override it (a random epoch, a boot
 * timestamp) could only ever make a strictly-newer push lose to a
 * strictly-older one.
 */
function isNewer(candidate: { revision: number }, current?: { revision: number }): boolean {
	if (!current) return true;
	return candidate.revision > current.revision;
}

/** Test/inspection seam — never imported by the master. */
export function currentHostTables() {
	return { runtimeTable, ingressTable };
}

/** Test-only reset of the in-memory module state. Never called from production code. */
export function resetHostTablesForTests(): void {
	runtimeTable = undefined;
	ingressTable = undefined;
}

const hostTableHandler: FastifyPluginAsync = async (fastify) => {
	const requireFleetCaller = async (req: FastifyRequest, reply: FastifyReply) => {
		await fastify.authenticate(req, reply);
		if (reply.sent) return;
		if (req.clusterAuth?.sub !== FLEET_SUB || req.clusterAuth?.workspaceId !== FLEET_WORKSPACE_ID) {
			return reply.code(403).send({ error: 'fleet_scoped_token_required' });
		}
	};

	fastify.put('/api/v1/fleet/host-table/runtime', { preHandler: requireFleetCaller }, async (req, reply) => {
		const parsed = RuntimeTableSchema.safeParse(req.body);
		if (!parsed.success) return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
		if (!isNewer(parsed.data, runtimeTable)) {
			return reply.send({ applied: false, revision: runtimeTable?.revision });
		}
		runtimeTable = { bootTimestamp: parsed.data.bootTimestamp, revision: parsed.data.revision, receivedAt: new Date().toISOString(), table: parsed.data.apps };
		return reply.send({ applied: true, revision: parsed.data.revision });
	});

	fastify.put('/api/v1/fleet/host-table/ingress', { preHandler: requireFleetCaller }, async (req, reply) => {
		const parsed = IngressTableSchema.safeParse(req.body);
		if (!parsed.success) return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
		if (!isNewer(parsed.data, ingressTable)) {
			return reply.send({ applied: false, revision: ingressTable?.revision });
		}
		ingressTable = {
			bootTimestamp: parsed.data.bootTimestamp,
			revision: parsed.data.revision,
			receivedAt: new Date().toISOString(),
			table: { rules: parsed.data.rules, signingKeys: parsed.data.signingKeys as Array<{ nodeId: string; kid: string; publicJwk: JsonWebKey }> },
		};
		return reply.send({ applied: true, revision: parsed.data.revision });
	});
};

export default hostTableHandler;
