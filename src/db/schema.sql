CREATE TABLE IF NOT EXISTS containers (
    id TEXT PRIMARY KEY,
    app_id TEXT,
    docker_container_id TEXT NOT NULL,
    docker_container_name TEXT NOT NULL,
    image TEXT NOT NULL,
    tag TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('created','running','stopped','error')),
    internal_url TEXT NOT NULL,
    port INTEGER NOT NULL,
    host_port INTEGER,
    memory_mb INTEGER NOT NULL,
    cpus REAL NOT NULL,
    tmp_size_mb INTEGER NOT NULL,
    env_vars TEXT NOT NULL DEFAULT '{}',
    health_status TEXT NOT NULL DEFAULT 'unknown',
    health_fail_count INTEGER NOT NULL DEFAULT 0,
    health_restart_count INTEGER NOT NULL DEFAULT 0,
    health_last_check INTEGER,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    stopped_at INTEGER,
    adopted INTEGER DEFAULT 0,
    subdomain TEXT,
    domain TEXT
);

CREATE INDEX IF NOT EXISTS idx_containers_state ON containers(state);
CREATE INDEX IF NOT EXISTS idx_containers_docker_id ON containers(docker_container_id);
CREATE INDEX IF NOT EXISTS idx_containers_app_id ON containers(app_id);
-- Uniqueness is per full host (subdomain + domain): blog.example.com and
-- blog.other.io may coexist, but two apps cannot share the same full host.
CREATE UNIQUE INDEX IF NOT EXISTS idx_containers_host
    ON containers(subdomain, domain) WHERE subdomain IS NOT NULL;

CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_pending ON webhook_events(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS volumes (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL,
  name TEXT NOT NULL,
  docker_volume_name TEXT NOT NULL,
  mount_path TEXT NOT NULL,
  size_mb INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE CASCADE,
  UNIQUE(container_id, name)
);
CREATE INDEX IF NOT EXISTS idx_volumes_container ON volumes(container_id);

CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  docker_image_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  tag TEXT NOT NULL,
  digest TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK(source IN ('pulled','built','registered')),
  built_by TEXT,
  description TEXT,
  labels TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(repository, tag)
);
CREATE INDEX IF NOT EXISTS idx_images_docker_id ON images(docker_image_id);
CREATE INDEX IF NOT EXISTS idx_images_built_by ON images(built_by);
CREATE INDEX IF NOT EXISTS idx_images_source ON images(source);

-- Cluster-wide key/value settings. Values are JSON-encoded strings so any
-- shape (string, number, object, array) can be stored without a schema
-- migration. Defaults live in code (src/services/settings-service.ts).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

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
