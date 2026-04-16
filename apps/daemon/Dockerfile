# ─── Stage 1: Install dependencies ──────────────────────────────────────────
# Copy only manifests first so this layer is cached between source changes.
FROM node:22-alpine AS deps

RUN npm install -g pnpm@10.29.3

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/daemon/package.json         ./apps/daemon/
COPY apps/frontoffice/package.json    ./apps/frontoffice/
COPY packages/core/package.json       ./packages/core/
COPY packages/mongodb/package.json    ./packages/mongodb/
COPY packages/storage/package.json    ./packages/storage/
COPY packages/enrichment/package.json ./packages/enrichment/
COPY packages/shared/package.json     ./packages/shared/
COPY infra/package.json               ./infra/

RUN pnpm install --frozen-lockfile

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine

RUN npm install -g pnpm@10.29.3

WORKDIR /app

# Copy the entire installed workspace from deps — this preserves all workspace
# package node_modules (packages/mongodb, packages/core, etc.) with their pnpm
# symlinks intact. Without this, workspace deps are missing at runtime.
COPY --from=deps /app ./

# Overlay with actual source (node_modules are excluded by .dockerignore so
# the installed ones from deps are preserved).
COPY . .

ENV NODE_ENV=production

# tsx handles TypeScript at runtime — no pre-compilation needed since all
# workspace packages export raw TypeScript source (main: ./src/index.ts).
# Workspace deps (mongodb, @pinecone-database/pinecone, etc.) come from deps stage.
WORKDIR /app/apps/daemon
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
