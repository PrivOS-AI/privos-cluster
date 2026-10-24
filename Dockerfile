# syntax=docker/dockerfile:1

# Stage 1: Builder — pure JS/TS build, no native module toolchain needed.
# Base pinned to the multi-arch index digest (amd64 + arm64); bump it deliberately.
FROM node:22.23.4-alpine3.23@sha256:6abbcf5dd6b231da109bcde1181db1d92bf78015ae1a9514d9807c1f857869db AS builder
WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Stage 2: Runner — minimal, with dumb-init for proper signal handling
FROM node:22.23.4-alpine3.23@sha256:6abbcf5dd6b231da109bcde1181db1d92bf78015ae1a9514d9807c1f857869db AS runner
RUN apk add --no-cache dumb-init
# CVE-2026-111497: fail the build on an unpatched Node. Compare the Node version, not process.versions.brotli
# (22.23.4 still reports brotli 1.1.0 because the fix was cherry-picked).
RUN node -e 'const v=process.versions.node.split(".").map(Number);const min={22:[22,23,4],24:[24,22,1],26:[26,12,1]}[v[0]];const ok=min&&(v[1]>min[1]||(v[1]===min[1]&&v[2]>=min[2]));if(!ok){console.error("Node "+process.version+" is below the CVE-2026-111497 minimum for its line");process.exit(1)}'
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
