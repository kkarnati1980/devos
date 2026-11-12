# syntax=docker/dockerfile:1.7
# DevOS images (R1-a, docs/modules/R1.md). One build stage, four runtime targets:
#   api · dashboard · worker · migrate
# No secret is a build argument or baked into a layer; configuration arrives at run time by name.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS build
# Manifests first so the dependency layer is cached across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .nvmrc ./
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/db/package.json packages/db/
COPY packages/intake/package.json packages/intake/
COPY packages/policy/package.json packages/policy/
COPY packages/provision/package.json packages/provision/
COPY packages/run-engine/package.json packages/run-engine/
COPY packages/shared/package.json packages/shared/
COPY packages/teardown/package.json packages/teardown/
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
RUN pnpm -r --workspace-concurrency=1 build

FROM base AS runtime
ARG GIT_SHA=unknown
ENV NODE_ENV=production GIT_SHA=${GIT_SHA}
COPY --from=build --chown=node:node /app /app
COPY --chown=node:node deploy/with-db-url.mjs /app/deploy/with-db-url.mjs
USER node

FROM runtime AS api
ENV HOST=0.0.0.0 PORT=3001
EXPOSE 3001
# R3-a (DEVOS-81): the api speaks HTTPS whenever a certificate file is set. This loopback liveness probe
# skips name verification (the certificate names the MagicDNS host, not 127.0.0.1); it sends nothing and
# reads only the status code. Real clients and the server checks always verify the certificate.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "const t=!!process.env.DEVOS_TLS_CERT_FILE;require(t?'node:https':'node:http').get({host:'127.0.0.1',port:process.env.PORT||3001,path:'/health',timeout:4000,rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"
CMD ["node", "deploy/with-db-url.mjs", "node", "apps/api/dist/main.js"]

FROM runtime AS dashboard
WORKDIR /app/apps/dashboard
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]

FROM runtime AS worker
CMD ["node", "deploy/with-db-url.mjs", "node", "packages/run-engine/dist/worker-main.js"]

FROM runtime AS migrate
WORKDIR /app/packages/db
CMD ["node", "/app/deploy/with-db-url.mjs", "node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
