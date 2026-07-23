# syntax=docker/dockerfile:1

# Stage 1: Builder — pure JS/TS build, no native module toolchain needed.
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Stage 2: Runner — minimal, with dumb-init for proper signal handling
FROM node:20-alpine AS runner
RUN apk add --no-cache dumb-init
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

RUN chown -R node:node /app
USER node

EXPOSE 4000
# Native reverse proxy (REVERSE_PROXY_MODE=native). In v1 the cluster runs on the
# host and the proxy binds 127.0.0.1 for the local cloudflared tunnel; running
# native mode inside this container would need a non-loopback bind (out of scope).
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:4000/api/v1/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
