# Consenso AI v2 — self-hosted container image.
# Builds the UI, then serves API + assets over Node with an embedded SQLite DB.
# Run:  docker compose up  (see SELF-HOST.md)  or:
#   docker build -t consenso-ai . && docker run -p 8787:8787 \
#     -e MASTER_KEY=$(openssl rand -hex 32) -e JWT_SECRET=$(openssl rand -hex 32) \
#     -v consenso-data:/app/data consenso-ai
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w apps/web

FROM node:22-alpine
WORKDIR /app/apps/worker
ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/data HOST=0.0.0.0
COPY --from=build /app /app
RUN mkdir -p /app/data && chown -R node:node /app/data
# Never run as root: only the data volume needs to be writable.
USER node
VOLUME /app/data
EXPOSE 8787
CMD ["npx", "tsx", "src/node-dev.ts"]
