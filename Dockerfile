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
COPY packages/policy/package.json packages/policy/
COPY packages/run-engine/package.json packages/run-engine/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
RUN pnpm -r --workspace-concurrency=1 build

FROM base AS runtime
ARG GIT_SHA=unknown
ENV NODE_ENV=production GIT_SHA=${GIT_SHA}
COPY --from=build --chown=node:node /app /app
USER node

FROM runtime AS api
ENV HOST=0.0.0.0 PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS dashboard
WORKDIR /app/apps/dashboard
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]

FROM runtime AS worker
CMD ["node", "packages/run-engine/dist/worker-main.js"]

FROM runtime AS migrate
WORKDIR /app/packages/db
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]
