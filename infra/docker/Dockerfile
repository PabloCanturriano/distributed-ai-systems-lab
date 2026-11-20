# Pin the official multi-platform Node 24 image; update the digest through review.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/configuration/package.json packages/configuration/package.json
COPY database/package.json database/package.json

FROM manifests AS build
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
COPY apps/worker/tsconfig.json apps/worker/tsconfig.json
COPY apps/worker/src apps/worker/src
COPY packages/configuration/tsconfig.json packages/configuration/tsconfig.json
COPY packages/configuration/src packages/configuration/src
RUN npm run build --workspace=@lab/configuration && npm run build --workspace=@lab/api --workspace=@lab/worker

FROM manifests AS api-dependencies
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace=@lab/api

FROM manifests AS worker-dependencies
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace=@lab/worker

FROM worker-dependencies AS relay-dependencies
COPY infra/docker/prepare-kafka-native.mjs /tmp/prepare-kafka-native.mjs
RUN node /tmp/prepare-kafka-native.mjs

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
ENV NODE_ENV=production APP_MODE=local
WORKDIR /app
USER node

FROM runtime AS api
COPY --from=api-dependencies /app/node_modules ./node_modules
COPY --from=build /app/packages/configuration/package.json ./packages/configuration/package.json
COPY --from=build /app/packages/configuration/dist ./packages/configuration/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
ENV API_HOST=0.0.0.0 API_PORT=3000
EXPOSE 3000
# Compose enables dependency readiness; standalone images default to liveness only.
HEALTHCHECK --interval=5s --timeout=3s --start-period=2s --retries=3 CMD ["node", "-e", "const host = process.env.API_HOST === '::1' ? '[::1]' : '127.0.0.1'; fetch('http://' + host + ':' + process.env.API_PORT + (process.env.API_DEPENDENCIES === 'local' ? '/health/ready' : '/health/live'), {signal: AbortSignal.timeout(2000)}).then(r => { if (!r.ok) process.exitCode = 1; }).catch(() => { process.exitCode = 1; });"]
CMD ["node", "apps/api/dist/main.js"]

# Select API or worker explicitly with --target; the worker exposes no HTTP port.
FROM runtime AS worker
COPY --from=worker-dependencies /app/node_modules ./node_modules
COPY --from=build /app/packages/configuration/package.json ./packages/configuration/package.json
COPY --from=build /app/packages/configuration/dist ./packages/configuration/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
CMD ["node", "apps/worker/dist/main.js"]

FROM worker AS relay
COPY --from=relay-dependencies /app/node_modules ./node_modules
CMD ["node", "apps/worker/dist/relay-main.js"]

FROM relay AS consumer
CMD ["node", "apps/worker/dist/consumer-main.js"]

FROM manifests AS database-build
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY database/tsconfig.json database/tsconfig.json
COPY database/src database/src
RUN npm run build --workspace=@lab/database

FROM manifests AS database-dependencies
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace=@lab/database

FROM runtime AS database
COPY --from=database-dependencies /app/node_modules ./node_modules
COPY --from=database-build /app/database/package.json ./database/package.json
COPY --from=database-build /app/database/dist ./database/dist
COPY database/bootstrap ./database/bootstrap
COPY database/migrations ./database/migrations
CMD ["node", "database/dist/initialize.js"]
