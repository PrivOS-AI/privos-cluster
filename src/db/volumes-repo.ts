import type BetterSqlite3 from 'better-sqlite3';
import type { ContainerVolumeRow } from '../types/index.js';
import { getDb } from './client.js';

// ---------------------------------------------------------------------------
// Row shape — mirrors the SQLite schema exactly
// ---------------------------------------------------------------------------
interface VolumeRow {
	id: string;
	container_id: string;
	name: string;
	docker_volume_name: string;
	mount_path: string;
	size_mb: number | null;
	created_at: number;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------
function rowToVolume(row: VolumeRow): ContainerVolumeRow {
	return {
		id: row.id,
		containerId: row.container_id,
		name: row.name,
		dockerVolumeName: row.docker_volume_name,
		mountPath: row.mount_path,
		sizeMb: row.size_mb ?? undefined,
		createdAt: row.created_at,
	};
}

function volumeToRow(v: ContainerVolumeRow): VolumeRow {
	return {
		id: v.id,
		container_id: v.containerId,
		name: v.name,
		docker_volume_name: v.dockerVolumeName,
		mount_path: v.mountPath,
		size_mb: v.sizeMb ?? null,
		created_at: v.createdAt,
	};
}

// ---------------------------------------------------------------------------
// Lazy DB reference
// ---------------------------------------------------------------------------
let _db: BetterSqlite3.Database | null = null;

function db(): BetterSqlite3.Database {
	if (!_db) _db = getDb();
	return _db;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function insert(row: ContainerVolumeRow): void {
	const r = volumeToRow(row);
	db()
		.prepare(
			`INSERT INTO volumes (
        id, container_id, name, docker_volume_name, mount_path, size_mb, created_at
      ) VALUES (
        @id, @container_id, @name, @docker_volume_name, @mount_path, @size_mb, @created_at
      )`,
		)
		.run(r);
}

export function findByContainerId(containerId: string): ContainerVolumeRow[] {
	return db()
		.prepare<string, VolumeRow>('SELECT * FROM volumes WHERE container_id = ? ORDER BY created_at ASC')
		.all(containerId)
		.map(rowToVolume);
}

export function deleteByContainerId(containerId: string): number {
	const result = db().prepare<string>('DELETE FROM volumes WHERE container_id = ?').run(containerId);
	return result.changes;
}

export function findByDockerVolumeName(name: string): ContainerVolumeRow | null {
	const row = db()
		.prepare<string, VolumeRow>('SELECT * FROM volumes WHERE docker_volume_name = ?')
		.get(name);
	return row ? rowToVolume(row) : null;
}
