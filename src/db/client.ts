import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

export function getDb(): Database.Database {
	if (db) return db;

	// Ensure the parent directory for the SQLite file exists
	const dbPath = resolve(config.SQLITE_PATH);
	mkdirSync(dirname(dbPath), { recursive: true });

	db = new Database(dbPath);
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('foreign_keys = ON');

	applyMigrations(db);

	const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');
	db.exec(schema);

	applyMigrations(db);

	return db;
}

function applyMigrations(db: Database.Database): void {
	const hasContainersTable = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'containers'")
		.get();
	if (!hasContainersTable) return;

	const containerCols = db.prepare("PRAGMA table_info(containers)").all() as any[];

	if (!containerCols.some((c: any) => c.name === 'adopted')) {
		db.exec('ALTER TABLE containers ADD COLUMN adopted INTEGER DEFAULT 0');
	}
	if (!containerCols.some((c: any) => c.name === 'subdomain')) {
		db.exec('ALTER TABLE containers ADD COLUMN subdomain TEXT');
	}
	// Multi-domain: track which base domain a container is published under, and
	// switch uniqueness from subdomain-only to the full host (subdomain, domain).
	if (!containerCols.some((c: any) => c.name === 'domain')) {
		db.exec('ALTER TABLE containers ADD COLUMN domain TEXT');
		db.exec('DROP INDEX IF EXISTS idx_containers_subdomain');
		db.exec(
			'CREATE UNIQUE INDEX IF NOT EXISTS idx_containers_host ' +
				'ON containers(subdomain, domain) WHERE subdomain IS NOT NULL',
		);
	}

	// images + settings tables use CREATE TABLE IF NOT EXISTS in schema.sql,
	// so no column-level migration is needed yet.

	// Add image_builds table if it doesn't exist
	const hasBuildsTable = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'image_builds'")
		.get();
	if (!hasBuildsTable) {
		db.exec(`
			CREATE TABLE IF NOT EXISTS image_builds (
			  id TEXT PRIMARY KEY,
			  repository TEXT NOT NULL,
			  tag TEXT NOT NULL,
			  dockerfile TEXT NOT NULL,
			  build_args TEXT NOT NULL DEFAULT '{}',
			  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
			  error_message TEXT,
			  image_id TEXT,
			  started_at INTEGER NOT NULL,
			  completed_at INTEGER,
			  created_by TEXT NOT NULL,
			  build_logs TEXT,
			  UNIQUE(repository, tag, started_at)
			);
			CREATE INDEX IF NOT EXISTS idx_image_builds_status ON image_builds(status);
			CREATE INDEX IF NOT EXISTS idx_image_builds_created_by ON image_builds(created_by);
			CREATE INDEX IF NOT EXISTS idx_image_builds_image_id ON image_builds(image_id);
		`);
	}
}

export function closeDb(): void {
	db?.close();
	db = null;
}
