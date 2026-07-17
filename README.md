# Privos Cluster

Standalone microservice that manages Docker containers for Privos MCP apps. Extracted from privos-chat (Meteor) to reduce coupling.

## Responsibilities

- Pull/create/start/stop/restart/remove Docker containers
- Health monitoring with auto-restart
- WebSocket terminal exec
- File browser (ls/cat into containers)
- Logs streaming
- JSON-RPC dispatch proxy to MCP containers
- Webhook state events back to privos-chat

## Architecture

```
privos-chat (Meteor)            privos-cluster (this)
  app metadata                    container runtime
  OAuth / install perms           Docker engine
  MongoDB mcp_apps                SQLite containers
       │                                │
       └──── HTTP API ──────────────────►
       ◄──── Webhook events ─────────────
```

## Setup

```bash
npm install
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET to match privos-chat
npm run dev
```

## Build & Run

```bash
# Local dev
npm run dev

# Production build
npm run build
npm start

# Docker
docker compose up --build
```

## Health

```bash
curl http://localhost:4000/api/v1/health
```

## Configuration

See `.env.example` for all environment variables.

## Project Structure

```
src/
├── server.ts              # Fastify entry
├── config.ts              # env validation (zod)
├── db/                    # SQLite schema + repo
├── docker/                # dockerode wrappers
├── services/              # lifecycle, health, webhook
├── handlers/              # REST + WebSocket routes
├── auth/                  # JWT
└── types/                 # shared types
```
