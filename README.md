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
`REVERSE_PROXY_MODE` (`off|caddy|native`), `PROXY_PORT`, `REVERSE_PROXY_ENABLED`
(legacy caddy gate), `DEFAULT_MEMORY_MB/CPUS/TMP_MB`, `HEALTH_CHECK_INTERVAL_MS`,
`DOCKER_SOCKET`/`DOCKER_NETWORK`. Shared-fleet agents additionally set
`FLEET_MODE=true`, a non-empty `IMAGE_REGISTRY_ALLOWLIST`, `APP_NETWORK_NAME`,
resource caps, `FLEET_NODE_ID`/`FLEET_NODE_KEY`, and
`CLUSTER_OPERATOR_ROUTES=off`; fleet mode rejects unpinned images, an empty
registry policy, non-WireGuard API binds, hub-issued tokens, and requests whose
workspace claim does not match the container label. Each workspace is attached
to `privos-ws-{workspaceId}-apps`; the agent container is connected for native
proxying, while app containers never share a network across workspaces.

## Branching

Environment-gated hardening shared by development and multi-tenancy lands on
`develop`. Multi-tenant agent and master work lands on `privos-mt`, cut from
the hardened `develop` head. Do not land fleet-only behavior on `develop`.

## Shared-fleet master

The `privos-mt` branch also builds `dockerfile-master`. The master is a
mesh-only control-plane service: hubs call
`/w/{workspaceId}/api/v1/*` with their workspace key; portal calls
`/admin/v1/*` with `APP_MASTER_SERVICE_KEY`. It schedules onto fleet agents
using per-node `kid` keys, persists state/lifecycle events in the control-plane
Mongo replica set, and programs per-app `privos.link` DNS records. It is never
in the public app UI request path.

```bash
cp .env.master.example .env.master
docker compose -f docker-compose.master.yml up -d --build
```

## Reverse proxy behind cloudflared (native mode)

In `REVERSE_PROXY_MODE=native` the cluster runs its own plain-HTTP reverse proxy
on `127.0.0.1:<PROXY_PORT>` and routes each request by `Host` to the target
container. **TLS is terminated by a Cloudflare Tunnel at the edge** — the cluster
holds no certificates and needs no ACME, no CF API token, no public 80/443.

- **No certs in the cluster.** cloudflared forwards `*.<domain> → localhost:<PROXY_PORT>`;
  Cloudflare's free Universal SSL covers `*.<domain>` (one subdomain level).
- **One-level subdomains only.** App hosts must be `<app>.<domain>` (e.g.
  `whoami.privos.link`). Deeper (`a.b.privos.link`) needs Cloudflare Advanced
  Certificate Manager (~$10/mo) — out of scope.
- **Routing.** A single wildcard tunnel ingress reaches the proxy, which dispatches
  by `Host` (open-relay guard: hosts outside `PRIVOS_DOMAINS` are rejected; only
  `running` containers are routed, else 502). WebSocket `upgrade` passes through.

Generate `.env` + the exact cloudflared config with the wizard:

```bash
npm run setup   # prompts, writes .env (0600), prints the ingress + DNS + hub secret
```

Then, on the cloudflared host, add the printed `ingress` block to the tunnel's
`config.yml`, run the printed `cloudflared tunnel route dns <tunnel> "*.<domain>"`,
and set the Cloudflare zone SSL mode to **Full**. Existing `caddy` setups are
unaffected (`REVERSE_PROXY_MODE=caddy`, the default); `off` disables routing.

### Live cutover runbook

1. `npm run setup` → mode `native`, domains `privos.link`, `PROXY_PORT=8080`; copy
   the printed cloudflared ingress + DNS command.
2. Apply the tunnel config (ingress + `route dns`), set zone SSL = **Full**.
3. Restart the cluster (`native`), deploy `traefik/whoami` (subdomain `whoami`).
4. Browse `https://whoami.privos.link` → valid Cloudflare cert, proxied to the
   container. Verify a WS app, 502 for an unknown host, foreign-host rejection.
5. When happy, make `native` the default and retire the caddy-docker-proxy container.

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
├── proxy/           # native HTTP reverse proxy (Host → container) + WS passthrough
├── services/        # lifecycle, health-monitor (in-memory), settings (env), resource-check
├── handlers/        # REST + WebSocket routes
├── auth/            # JWT verify
└── types/           # shared types
scripts/
├── setup-wizard.ts        # `npm run setup` — writes .env + prints cloudflared config
└── cloudflared-ingress.ts # pure ingress/DNS/env-merge renderers (unit tested)
```
