# ─── Stage 1: Install dependencies ──────────────────────────────────────────
# Separate from source copy so pnpm install is cached between source changes.
FROM node:22-alpine AS deps

RUN npm install -g pnpm@10.29.3

WORKDIR /app

# Copy only manifests (lockfile + all package.json files in the workspace)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/daemon/package.json        ./apps/daemon/
COPY apps/frontoffice/package.json   ./apps/frontoffice/
COPY packages/core/package.json      ./packages/core/
COPY packages/neo4j/package.json     ./packages/neo4j/
COPY packages/storage/package.json   ./packages/storage/
COPY packages/enrichment/package.json ./packages/enrichment/
COPY packages/shared/package.json    ./packages/shared/
COPY infra/package.json              ./infra/

RUN pnpm install --frozen-lockfile

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine

RUN npm install -g pnpm@10.29.3

WORKDIR /app

# Copy installed node_modules (includes virtual store + workspace symlinks)
COPY --from=deps /app/node_modules ./node_modules
# Copy daemon's own node_modules (contains .bin/tsx from devDependencies)
COPY --from=deps /app/apps/daemon/node_modules ./apps/daemon/node_modules

# Copy all source (packages/ symlink targets now resolve correctly)
COPY . .

ENV NODE_ENV=production

# tsx handles TypeScript at runtime — no pre-compilation needed since all
# workspace packages export raw TypeScript source (main: ./src/index.ts).
WORKDIR /app/apps/daemon
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
