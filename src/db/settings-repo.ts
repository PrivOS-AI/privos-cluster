import type BetterSqlite3 from 'better-sqlite3';
import type { Setting } from '../types/index.js';
import { getDb } from './client.js';

interface SettingRow {
	key: string;
	value: string; // JSON-encoded
	updated_at: number;
	updated_by: string | null;
}

function rowToSetting<T>(row: SettingRow): Setting<T> {
	return {
		key: row.key,
		value: JSON.parse(row.value) as T,
		updatedAt: row.updated_at,
		updatedBy: row.updated_by,
	};
}

let _db: BetterSqlite3.Database | null = null;
function db(): BetterSqlite3.Database {
	if (!_db) _db = getDb();
	return _db;
}

export function get<T = unknown>(key: string): Setting<T> | null {
	const row = db().prepare<string, SettingRow>('SELECT * FROM settings WHERE key = ?').get(key);
	return row ? rowToSetting<T>(row) : null;
}

export function findAll(): Setting[] {
	return db()
		.prepare<[], SettingRow>('SELECT * FROM settings ORDER BY key')
		.all()
		.map((r) => rowToSetting(r));
}

export function set<T>(key: string, value: T, updatedBy: string | null = null): Setting<T> {
	const now = Date.now();
	db()
		.prepare(
			`INSERT INTO settings (key, value, updated_at, updated_by)
			 VALUES (@key, @value, @updatedAt, @updatedBy)
			 ON CONFLICT(key) DO UPDATE SET
			   value = excluded.value,
			   updated_at = excluded.updated_at,
			   updated_by = excluded.updated_by`,
		)
		.run({ key, value: JSON.stringify(value), updatedAt: now, updatedBy });
	return { key, value, updatedAt: now, updatedBy };
}

export function deleteByKey(key: string): boolean {
	const result = db().prepare<string>('DELETE FROM settings WHERE key = ?').run(key);
	return result.changes > 0;
}
