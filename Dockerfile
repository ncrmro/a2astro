# syntax=docker/dockerfile:1
#
# a2astro runs as a standalone Astro node server. Git is a runtime dependency:
# workflow catalogs are fetched from their pinned revision on first use.

FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM docker.io/library/node:22-alpine AS runtime
RUN apk add --no-cache git ca-certificates
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    A2ASTRO_CONFIG=/etc/a2astro/a2astro.config.yaml
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# The data directory holds jobs.json and the catalog cache; mount a volume here.
RUN mkdir -p /var/lib/a2astro && chown -R node:node /var/lib/a2astro /app
USER node
EXPOSE 4321
CMD ["node", "./dist/server/entry.mjs"]
