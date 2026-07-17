import type BetterSqlite3 from 'better-sqlite3';
import type { Container, ContainerState, HealthCheck } from '../types/index.js';
import { getDb } from './client.js';

// ---------------------------------------------------------------------------
// Row shape — mirrors the SQLite schema exactly
// ---------------------------------------------------------------------------
interface ContainerRow {
	id: string;
	app_id: string | null;
	docker_container_id: string;
	docker_container_name: string;
	image: string;
	tag: string;
	state: string;
	internal_url: string;
	port: number;
	host_port: number | null;
	memory_mb: number;
	cpus: number;
	tmp_size_mb: number;
	env_vars: string; // JSON
	health_status: string;
	health_fail_count: number;
	health_restart_count: number;
	health_last_check: number | null;
	created_at: number;
	started_at: number | null;
	stopped_at: number | null;
	adopted: number; // 0 or 1
	subdomain: string | null;
	domain: string | null;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------
function rowToContainer(row: ContainerRow): Container {
	return {
		id: row.id,
		appId: row.app_id,
		dockerContainerId: row.docker_container_id,
		dockerContainerName: row.docker_container_name,
		image: row.image,
		tag: row.tag,
		state: row.state as ContainerState,
		internalUrl: row.internal_url,
		port: row.port,
		hostPort: row.host_port,
		resources: {
			memoryMb: row.memory_mb,
			cpus: row.cpus,
			tmpSizeMb: row.tmp_size_mb,
		},
		envVars: JSON.parse(row.env_vars) as Record<string, string>,
		healthCheck: {
			status: row.health_status as HealthCheck['status'],
			failCount: row.health_fail_count,
			restartCount: row.health_restart_count,
			lastCheck: row.health_last_check,
		},
		createdAt: row.created_at,
		startedAt: row.started_at,
		stoppedAt: row.stopped_at,
		adopted: row.adopted === 1,
		volumes: [], // populated by callers that join with volumes table
		subdomain: row.subdomain,
		domain: row.domain,
	};
}

function containerToRow(c: Container): ContainerRow {
	return {
		id: c.id,
		app_id: c.appId,
		docker_container_id: c.dockerContainerId,
		docker_container_name: c.dockerContainerName,
		image: c.image,
		tag: c.tag,
		state: c.state,
		internal_url: c.internalUrl,
		port: c.port,
		host_port: c.hostPort,
		memory_mb: c.resources.memoryMb,
		cpus: c.resources.cpus,
		tmp_size_mb: c.resources.tmpSizeMb,
		env_vars: JSON.stringify(c.envVars),
		health_status: c.healthCheck.status,
		health_fail_count: c.healthCheck.failCount,
		health_restart_count: c.healthCheck.restartCount,
		health_last_check: c.healthCheck.lastCheck,
		created_at: c.createdAt,
		started_at: c.startedAt,
		stopped_at: c.stoppedAt,
		adopted: c.adopted ? 1 : 0,
		subdomain: c.subdomain ?? null,
		domain: c.domain ?? null,
	};
}

// ---------------------------------------------------------------------------
// Prepared-statement cache (lazy init — avoids eager DB open at import time)
// ---------------------------------------------------------------------------
let _db: BetterSqlite3.Database | null = null;

function db(): BetterSqlite3.Database {
	if (!_db) _db = getDb();
	return _db;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function insert(container: Container): void {
	const row = containerToRow(container);
	db()
		.prepare(
			`INSERT INTO containers (
        id, app_id, docker_container_id, docker_container_name,
        image, tag, state, internal_url, port, host_port,
        memory_mb, cpus, tmp_size_mb, env_vars,
        health_status, health_fail_count, health_restart_count, health_last_check,
        created_at, started_at, stopped_at, adopted, subdomain, domain
      ) VALUES (
        @id, @app_id, @docker_container_id, @docker_container_name,
        @image, @tag, @state, @internal_url, @port, @host_port,
        @memory_mb, @cpus, @tmp_size_mb, @env_vars,
        @health_status, @health_fail_count, @health_restart_count, @health_last_check,
        @created_at, @started_at, @stopped_at, @adopted, @subdomain, @domain
      )`,
		)
		.run(row);
}

export function findBySubdomain(subdomain: string): Container | null {
	const row = db()
		.prepare<string, ContainerRow>('SELECT * FROM containers WHERE subdomain = ?')
		.get(subdomain);
	return row ? rowToContainer(row) : null;
}

/**
 * Find a container by its full public host (subdomain + domain). Used for
 * per-host uniqueness so the same subdomain can exist under different domains.
 */
export function findByHost(subdomain: string, domain: string | null): Container | null {
	const row = db()
		.prepare<[string, string | null], ContainerRow>(
			'SELECT * FROM containers WHERE subdomain = ? AND domain IS ?',
		)
		.get(subdomain, domain);
	return row ? rowToContainer(row) : null;
}

export function updateSubdomain(id: string, subdomain: string | null): void {
	db()
		.prepare<[string | null, string]>(
			'UPDATE containers SET subdomain = ? WHERE id = ?',
		)
		.run(subdomain, id);
}

export function findById(id: string): Container | null {
	const row = db().prepare<string, ContainerRow>('SELECT * FROM containers WHERE id = ?').get(id);
	return row ? rowToContainer(row) : null;
}

export function findByDockerContainerId(dockerId: string): Container | null {
	const row = db()
		.prepare<string, ContainerRow>('SELECT * FROM containers WHERE docker_container_id = ?')
		.get(dockerId);
	return row ? rowToContainer(row) : null;
}

export function findAll(): Container[] {
	return db()
		.prepare<[], ContainerRow>('SELECT * FROM containers ORDER BY created_at DESC')
		.all()
		.map(rowToContainer);
}

export function findByState(state: ContainerState): Container[] {
	return db()
		.prepare<string, ContainerRow>('SELECT * FROM containers WHERE state = ? ORDER BY created_at DESC')
		.all(state)
		.map(rowToContainer);
}

export function findRunning(): Container[] {
	return findByState('running');
}

export function update(id: string, patch: Partial<Container>): void {
	// Build a dynamic SET clause from patch fields mapped to column names
	const colMap: Record<string, string> = {
		appId: 'app_id',
		dockerContainerId: 'docker_container_id',
		dockerContainerName: 'docker_container_name',
		image: 'image',
		tag: 'tag',
		state: 'state',
		internalUrl: 'internal_url',
		port: 'port',
		hostPort: 'host_port',
		envVars: 'env_vars',
		createdAt: 'created_at',
		startedAt: 'started_at',
		stoppedAt: 'stopped_at',
		subdomain: 'subdomain',
		domain: 'domain',
	};

	const setClauses: string[] = [];
	const values: Record<string, unknown> = { id };

	for (const [key, value] of Object.entries(patch)) {
		if (key === 'id' || key === 'resources' || key === 'healthCheck') continue;
		const col = colMap[key];
		if (!col) continue;
		const paramName = col.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
		setClauses.push(`${col} = @${paramName}`);
		values[paramName] = key === 'envVars' ? JSON.stringify(value) : value;
	}

	// Handle nested resources
	if (patch.resources) {
		if (patch.resources.memoryMb !== undefined) {
			setClauses.push('memory_mb = @memoryMb');
			values['memoryMb'] = patch.resources.memoryMb;
		}
		if (patch.resources.cpus !== undefined) {
			setClauses.push('cpus = @cpus');
			values['cpus'] = patch.resources.cpus;
		}
		if (patch.resources.tmpSizeMb !== undefined) {
			setClauses.push('tmp_size_mb = @tmpSizeMb');
			values['tmpSizeMb'] = patch.resources.tmpSizeMb;
		}
	}

	// Handle nested healthCheck
	if (patch.healthCheck) {
		const hc = patch.healthCheck;
		if (hc.status !== undefined) {
			setClauses.push('health_status = @healthStatus');
			values['healthStatus'] = hc.status;
		}
		if (hc.failCount !== undefined) {
			setClauses.push('health_fail_count = @healthFailCount');
			values['healthFailCount'] = hc.failCount;
		}
		if (hc.restartCount !== undefined) {
			setClauses.push('health_restart_count = @healthRestartCount');
			values['healthRestartCount'] = hc.restartCount;
		}
		if (hc.lastCheck !== undefined) {
			setClauses.push('health_last_check = @healthLastCheck');
			values['healthLastCheck'] = hc.lastCheck;
		}
	}

	if (setClauses.length === 0) return;

	db()
		.prepare(`UPDATE containers SET ${setClauses.join(', ')} WHERE id = @id`)
		.run(values);
}

export function updateState(
	id: string,
	state: ContainerState,
	extra?: {
		startedAt?: number | null;
		stoppedAt?: number | null;
		internalUrl?: string;
		hostPort?: number | null;
	},
): void {
	const setClauses: string[] = ['state = @state'];
	const values: Record<string, unknown> = { id, state };

	if (extra?.startedAt !== undefined) {
		setClauses.push('started_at = @startedAt');
		values['startedAt'] = extra.startedAt;
	}
	if (extra?.stoppedAt !== undefined) {
		setClauses.push('stopped_at = @stoppedAt');
		values['stoppedAt'] = extra.stoppedAt;
	}
	if (extra?.internalUrl !== undefined) {
		setClauses.push('internal_url = @internalUrl');
		values['internalUrl'] = extra.internalUrl;
	}
	if (extra?.hostPort !== undefined) {
		setClauses.push('host_port = @hostPort');
		values['hostPort'] = extra.hostPort;
	}

	db()
		.prepare(`UPDATE containers SET ${setClauses.join(', ')} WHERE id = @id`)
		.run(values);
}

export function updateHealthCheck(id: string, hc: Partial<HealthCheck>): void {
	const setClauses: string[] = [];
	const values: Record<string, unknown> = { id };

	if (hc.status !== undefined) {
		setClauses.push('health_status = @status');
		values['status'] = hc.status;
	}
	if (hc.failCount !== undefined) {
		setClauses.push('health_fail_count = @failCount');
		values['failCount'] = hc.failCount;
	}
	if (hc.restartCount !== undefined) {
		setClauses.push('health_restart_count = @restartCount');
		values['restartCount'] = hc.restartCount;
	}
	if (hc.lastCheck !== undefined) {
		setClauses.push('health_last_check = @lastCheck');
		values['lastCheck'] = hc.lastCheck;
	}

	if (setClauses.length === 0) return;

	db()
		.prepare(`UPDATE containers SET ${setClauses.join(', ')} WHERE id = @id`)
		.run(values);
}

export function deleteById(id: string): void {
	db().prepare<string>('DELETE FROM containers WHERE id = ?').run(id);
}
