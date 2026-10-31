# DevOS M0.5 — Agent SDK spike image. Version: 1.0.0
# Pinned base + pinned SDK (package-lock.json). Runs as the unprivileged `node` user (uid 1000).
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY run.mjs ./
USER node
ENV HOME=/tmp NODE_ENV=production
ENTRYPOINT ["node", "/app/run.mjs"]
