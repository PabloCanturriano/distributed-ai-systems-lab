FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS dependencies
WORKDIR /probe
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY prepare-native.mjs ./
RUN node prepare-native.mjs

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production
WORKDIR /probe
COPY --from=dependencies /probe/node_modules ./node_modules
COPY package.json probe.mjs consumer.mjs ./
USER node
CMD ["node", "probe.mjs"]
