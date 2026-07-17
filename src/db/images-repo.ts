import type BetterSqlite3 from 'better-sqlite3';
import type { Image, ImageSource } from '../types/index.js';
import { getDb } from './client.js';

interface ImageRow {
	id: string;
	docker_image_id: string;
	repository: string;
	tag: string;
	digest: string | null;
	size_bytes: number;
	source: string;
	built_by: string | null;
	description: string | null;
	labels: string; // JSON
	created_at: number;
	updated_at: number;
}

function rowToImage(row: ImageRow): Image {
	return {
		id: row.id,
		dockerImageId: row.docker_image_id,
		repository: row.repository,
		tag: row.tag,
		digest: row.digest,
		sizeBytes: row.size_bytes,
		source: row.source as ImageSource,
		builtBy: row.built_by,
		description: row.description,
		labels: JSON.parse(row.labels) as Record<string, string>,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

let _db: BetterSqlite3.Database | null = null;
function db(): BetterSqlite3.Database {
	if (!_db) _db = getDb();
	return _db;
}

export interface ListFilters {
	source?: ImageSource;
	builtBy?: string;     // exact match (e.g. JWT sub)
	q?: string;           // search repository LIKE
}

export function findAll(filters: ListFilters = {}): Image[] {
	const wheres: string[] = [];
	const params: Record<string, unknown> = {};
	if (filters.source) {
		wheres.push('source = @source');
		params.source = filters.source;
	}
	if (filters.builtBy) {
		wheres.push('built_by = @builtBy');
		params.builtBy = filters.builtBy;
	}
	if (filters.q) {
		wheres.push('(repository LIKE @q OR tag LIKE @q)');
		params.q = `%${filters.q}%`;
	}
	const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
	return db()
		.prepare<Record<string, unknown>, ImageRow>(
			`SELECT * FROM images ${where} ORDER BY updated_at DESC`,
		)
		.all(params)
		.map(rowToImage);
}

export function findById(id: string): Image | null {
	const row = db()
		.prepare<string, ImageRow>('SELECT * FROM images WHERE id = ?')
		.get(id);
	return row ? rowToImage(row) : null;
}

export function findByRepoTag(repository: string, tag: string): Image | null {
	const row = db()
		.prepare<[string, string], ImageRow>(
			'SELECT * FROM images WHERE repository = ? AND tag = ?',
		)
		.get(repository, tag);
	return row ? rowToImage(row) : null;
}

export function findByDockerImageId(dockerImageId: string): Image[] {
	return db()
		.prepare<string, ImageRow>('SELECT * FROM images WHERE docker_image_id = ?')
		.all(dockerImageId)
		.map(rowToImage);
}

export function insert(img: Image): void {
	db()
		.prepare(
			`INSERT INTO images (
				id, docker_image_id, repository, tag, digest, size_bytes,
				source, built_by, description, labels, created_at, updated_at
			) VALUES (
				@id, @dockerImageId, @repository, @tag, @digest, @sizeBytes,
				@source, @builtBy, @description, @labels, @createdAt, @updatedAt
			)`,
		)
		.run({
			id: img.id,
			dockerImageId: img.dockerImageId,
			repository: img.repository,
			tag: img.tag,
			digest: img.digest,
			sizeBytes: img.sizeBytes,
			source: img.source,
			builtBy: img.builtBy,
			description: img.description,
			labels: JSON.stringify(img.labels),
			createdAt: img.createdAt,
			updatedAt: img.updatedAt,
		});
}

/**
 * Upsert by (repository, tag) — used by reconciliation and pull/build flows
 * to keep DB in sync with Docker daemon without violating UNIQUE constraint.
 */
export function upsertByRepoTag(img: Image): Image {
	const existing = findByRepoTag(img.repository, img.tag);
	if (existing) {
		update(existing.id, {
			dockerImageId: img.dockerImageId,
			digest: img.digest,
			sizeBytes: img.sizeBytes,
			source: img.source,
			labels: img.labels,
			updatedAt: img.updatedAt,
		});
		return { ...existing, ...img, id: existing.id, createdAt: existing.createdAt };
	}
	insert(img);
	return img;
}

export interface UpdatePatch {
	dockerImageId?: string;
	digest?: string | null;
	sizeBytes?: number;
	source?: ImageSource;
	description?: string | null;
	labels?: Record<string, string>;
	updatedAt?: number;
}

export function update(id: string, patch: UpdatePatch): void {
	const colMap: Record<string, string> = {
		dockerImageId: 'docker_image_id',
		digest: 'digest',
		sizeBytes: 'size_bytes',
		source: 'source',
		description: 'description',
		updatedAt: 'updated_at',
	};
	const setClauses: string[] = [];
	const values: Record<string, unknown> = { id };
	for (const [key, value] of Object.entries(patch)) {
		if (key === 'labels') {
			setClauses.push('labels = @labels');
			values.labels = JSON.stringify(value ?? {});
			continue;
		}
		const col = colMap[key];
		if (!col) continue;
		setClauses.push(`${col} = @${key}`);
		values[key] = value;
	}
	if (setClauses.length === 0) return;
	// Always bump updated_at if caller didn't set it
	if (!('updatedAt' in patch)) {
		setClauses.push('updated_at = @autoUpdatedAt');
		values.autoUpdatedAt = Date.now();
	}
	db()
		.prepare(`UPDATE images SET ${setClauses.join(', ')} WHERE id = @id`)
		.run(values);
}

export function deleteById(id: string): void {
	db().prepare<string>('DELETE FROM images WHERE id = ?').run(id);
}

/**
 * Returns the number of running/created containers currently referencing this image.
 * Used as a soft guard before deleting an image.
 */
export function countInUse(repository: string, tag: string): number {
	const row = db()
		.prepare<[string, string], { c: number }>(
			"SELECT COUNT(*) AS c FROM containers WHERE image = ? AND tag = ? AND state IN ('running','created','stopped')",
		)
		.get(repository, tag);
	return row?.c ?? 0;
}
