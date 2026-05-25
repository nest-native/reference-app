# Multi-stage production example for nest-native/reference-app.
#
# Stage 1 (builder): install deps, compile TypeScript to dist/.
# Stage 2 (runtime): copy dist/ + production deps + migrations + seed script.
#
# Build:   docker build -t reference-app:latest .
# Run API: docker run --rm -p 3000:3000 \
#            -v reference-app-data:/data \
#            -e DATABASE_URL=/data/app.db \
#            -e AUTH_SECRET=replace-me-32-chars-or-more-xxxxxxxxxxxxxx \
#            reference-app:latest
# Run worker (separate process, same image):
#          docker run --rm -v reference-app-data:/data \
#            -e DATABASE_URL=/data/app.db \
#            -e AUTH_SECRET=… \
#            reference-app:latest node dist/scripts/start-worker.js
#
# See docker-compose.yml for a full API + worker stack.

ARG NODE_VERSION=20

# -------- stage 1: builder --------
FROM node:${NODE_VERSION}-bookworm-slim AS builder

# better-sqlite3 needs python + a C++ toolchain for the prebuild fallback.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.base.json tsconfig.build.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Generate the tRPC schema once so the build artifact ships with it.
RUN npx tsx src/trpc/generate-types.ts
RUN npm run build

# -------- stage 2: runtime --------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Production-only deps. better-sqlite3's prebuilt binary is fetched here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force

# Compiled JS + migrations + seed script (so the same image can also seed).
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/@generated ./src/@generated
COPY src/database/migrations ./src/database/migrations
COPY scripts ./scripts

# Mount a volume here for SQLite persistence in single-host deployments.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# Default command runs the API. Override `node dist/scripts/start-worker.js`
# to run the outbox worker instead.
CMD ["node", "dist/main.js"]
