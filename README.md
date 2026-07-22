# Privos Cluster

Stateless Docker agent for Privos MCP apps. It executes container operations on
one Docker host and is managed entirely by **privos-hub** (Admin > Apps > App
Clusters). It has **no database and no UI** — Docker itself is the source of
truth: every container's metadata is written to `privos.*` labels at create time,
so the agent can reconstruct all state from `docker ps` + `docker inspect` and
survives restarts with nothing to migrate.

## Responsibilities

- Pull/create/start/stop/restart/redeploy/remove Docker containers (from existing images)
- Zero-downtime rolling redeploy (volume-free apps)
- In-memory health monitoring with label-driven self-restart (independent of hub)
- WebSocket terminal exec, file browser (ls/cat), logs streaming
- JSON-RPC dispatch proxy to MCP containers
- Per-host subdomain uniqueness + resource budget — computed from labels, no DB

## Architecture

```
privos-hub (Meteor)              privos-cluster (this)
  app_clusters registry            container runtime
  encrypted JWT secret             Docker engine
  App Clusters admin UI            Docker labels = state (privos.*)
       │                                │
       └──── HTTP API (iss=privos-chat, HS256) ──►
                     pure polling — no webhooks
```

Hub mints a short-lived HS256 token (issuer `privos-chat`, the only trusted
issuer) per request. There is no local admin login, no image-build/registry
browsing, and no webhook delivery — hub reads all state by polling `/apps`.

## Labels (the record)

Written at create; immutable afterwards (changing metadata = recreate):
`privos.managed`, `privos.id` (API container id), `privos.app-id`,
`privos.image`, `privos.tag`, `privos.port`, `privos.resources` (JSON),
`privos.env` (user env JSON), `privos.subdomain`, `privos.domain`,
`privos.created-at/by`, `privos.health.path|max-fails|restart` (+ caddy labels
when routed).

## Setup

```bash
npm install
cp .env.example .env   # set JWT_SECRET to the per-cluster secret registered in hub
npm run dev
```

## Build & Run

```bash
npm run dev                # local dev
npm run build && npm start # production
docker compose up --build  # docker
npm test                   # unit tests (node:test + tsx)
```

## Health

```bash
curl http://localhost:4000/api/v1/health
```

## Configuration

See `.env.example`. Key vars: `JWT_SECRET` (shared with hub), `PRIVOS_DOMAINS`,
`REVERSE_PROXY_ENABLED`, `DEFAULT_MEMORY_MB/CPUS/TMP_MB`,
`HEALTH_CHECK_INTERVAL_MS`, `DOCKER_SOCKET`/`DOCKER_NETWORK`.

## Cutover from the legacy SQLite build

Greenfield (no legacy containers to preserve):

1. Deploy this image (compose no longer mounts a `cluster-data` volume; drop the
   old `SQLITE_PATH`/`ADMIN_*`/`PRIVOS_CHAT_WEBHOOK_URL` env).
2. Register/point the cluster in hub (Admin > Apps > App Clusters) and redeploy
   apps through hub — new containers get the full `privos.*` label schema.
3. Old SQLite-era containers (no `privos.managed` label) are simply not managed;
   remove them manually if any exist.

## Project Structure

```
src/
├── server.ts        # Fastify entry (no DB init)
├── config.ts        # env validation (zod)
├── docker/          # dockerode wrappers + docker-state (labels → Container) + mapper
├── services/        # lifecycle, health-monitor (in-memory), settings (env), resource-check
├── handlers/        # REST + WebSocket routes
├── auth/            # JWT verify
└── types/           # shared types
```
