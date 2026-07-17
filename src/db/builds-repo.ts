import type BetterSqlite3 from 'better-sqlite3';
import type { ImageBuild } from '../types/index.js';
import { getDb } from './client.js';

interface ImageBuildRow {
	id: string;
	repository: string;
	tag: string;
	dockerfile: string;
	build_args: string;
	status: string;
	error_message: string | null;
	image_id: string | null;
	started_at: number;
	completed_at: number | null;
	created_by: string;
	build_logs: string | null;
}

function rowToImageBuild(row: ImageBuildRow): ImageBuild {
	return {
		id: row.id,
		repository: row.repository,
		tag: row.tag,
		dockerfile: row.dockerfile,
		buildArgs: JSON.parse(row.build_args) as Record<string, string>,
		status: row.status as 'pending' | 'running' | 'completed' | 'failed',
		errorMessage: row.error_message,
		imageId: row.image_id,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		createdBy: row.created_by,
		buildLogs: row.build_logs,
	};
}

let _db: BetterSqlite3.Database | null = null;
function db(): BetterSqlite3.Database {
	if (!_db) _db = getDb();
	return _db;
}

export interface ListBuildsFilters {
	status?: 'pending' | 'running' | 'completed' | 'failed';
	createdBy?: string;
	limit?: number;
}

export function findAll(filters: ListBuildsFilters = {}): ImageBuild[] {
	const wheres: string[] = [];
	const params: Record<string, unknown> = {};

	if (filters.status) {
		wheres.push('status = @status');
		params.status = filters.status;
	}
	if (filters.createdBy) {
		wheres.push('created_by = @createdBy');
		params.createdBy = filters.createdBy;
	}

	const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
	const limit = filters.limit ? `LIMIT ${filters.limit}` : '';

	return db()
		.prepare<Record<string, unknown>, ImageBuildRow>(
			`SELECT * FROM image_builds ${where} ORDER BY started_at DESC ${limit}`,
		)
		.all(params)
		.map(rowToImageBuild);
}

export function findById(id: string): ImageBuild | null {
	const row = db()
		.prepare<string, ImageBuildRow>('SELECT * FROM image_builds WHERE id = ?')
		.get(id);
	return row ? rowToImageBuild(row) : null;
}

export function findByRepoTag(repository: string, tag: string): ImageBuild[] {
	return db()
		.prepare<[string, string], ImageBuildRow>(
			'SELECT * FROM image_builds WHERE repository = ? AND tag = ? ORDER BY started_at DESC',
		)
		.all(repository, tag)
		.map(rowToImageBuild);
}

export function insert(build: ImageBuild): void {
	db()
		.prepare(
			`INSERT INTO image_builds (
				id, repository, tag, dockerfile, build_args, status, error_message,
				image_id, started_at, completed_at, created_by, build_logs
			) VALUES (
				@id, @repository, @tag, @dockerfile, @buildArgs, @status, @errorMessage,
				@imageId, @startedAt, @completedAt, @createdBy, @buildLogs
			)`,
		)
		.run({
			id: build.id,
			repository: build.repository,
			tag: build.tag,
			dockerfile: build.dockerfile,
			buildArgs: JSON.stringify(build.buildArgs),
			status: build.status,
			errorMessage: build.errorMessage,
			imageId: build.imageId,
			startedAt: build.startedAt,
			completedAt: build.completedAt,
			createdBy: build.createdBy,
			buildLogs: build.buildLogs,
		});
}

export interface UpdateBuildPatch {
	status?: 'pending' | 'running' | 'completed' | 'failed';
	errorMessage?: string | null;
	imageId?: string | null;
	completedAt?: number | null;
	buildLogs?: string | null;
}

export function update(id: string, patch: UpdateBuildPatch): void {
	const colMap: Record<string, string> = {
		status: 'status',
		errorMessage: 'error_message',
		imageId: 'image_id',
		completedAt: 'completed_at',
		buildLogs: 'build_logs',
	};

	const setClauses: string[] = [];
	const values: Record<string, unknown> = { id };

	for (const [key, value] of Object.entries(patch)) {
		const col = colMap[key];
		if (!col) continue;
		setClauses.push(`${col} = @${key}`);
		values[key] = value;
	}

	if (setClauses.length === 0) return;

	db()
		.prepare(`UPDATE image_builds SET ${setClauses.join(', ')} WHERE id = @id`)
		.run(values);
}

export function deleteById(id: string): void {
	db().prepare<string>('DELETE FROM image_builds WHERE id = ?').run(id);
}

/**
 * Find all running builds that might be stalled (started more than 1 hour ago
 * and still not completed). Used for cleanup jobs.
 */
export function findStalledBuilds(stalledThresholdMs: number = 60 * 60 * 1000): ImageBuild[] {
	const stalledTime = Date.now() - stalledThresholdMs;
	return db()
		.prepare<Record<string, unknown>, ImageBuildRow>(
			'SELECT * FROM image_builds WHERE status IN ("pending", "running") AND started_at < @stalledTime',
		)
		.all({ stalledTime })
		.map(rowToImageBuild);
}

/**
 * Get build statistics for a user
 */
export function getStatsForUser(createdBy: string): {
	total: number;
	completed: number;
	failed: number;
	running: number;
} {
	const total = db()
		.prepare<string, { c: number }>(
			'SELECT COUNT(*) AS c FROM image_builds WHERE created_by = ?',
		)
		.get(createdBy)?.c ?? 0;

	const completed = db()
		.prepare<string, { c: number }>(
			'SELECT COUNT(*) AS c FROM image_builds WHERE created_by = ? AND status = "completed"',
		)
		.get(createdBy)?.c ?? 0;

	const failed = db()
		.prepare<string, { c: number }>(
			'SELECT COUNT(*) AS c FROM image_builds WHERE created_by = ? AND status = "failed"',
		)
		.get(createdBy)?.c ?? 0;

	const running = db()
		.prepare<string, { c: number }>(
			'SELECT COUNT(*) AS c FROM image_builds WHERE created_by = ? AND status IN ("pending", "running")',
		)
		.get(createdBy)?.c ?? 0;

	return { total, completed, failed, running };
}
