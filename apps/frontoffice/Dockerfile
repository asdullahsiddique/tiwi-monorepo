# ─── Stage 1: Install dependencies ──────────────────────────────────────────
# Copy only manifests first so this layer is cached between source-only changes.
FROM node:22-alpine AS deps

RUN npm install -g pnpm@10.29.3

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/frontoffice/package.json   ./apps/frontoffice/
COPY apps/daemon/package.json        ./apps/daemon/
COPY packages/core/package.json      ./packages/core/
COPY packages/neo4j/package.json     ./packages/neo4j/
COPY packages/storage/package.json   ./packages/storage/
COPY packages/enrichment/package.json ./packages/enrichment/
COPY packages/shared/package.json    ./packages/shared/
COPY infra/package.json              ./infra/

RUN pnpm install --frozen-lockfile

# ─── Stage 2: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN npm install -g pnpm@10.29.3

WORKDIR /app

# Copy installed deps (with workspace symlinks intact)
COPY --from=deps /app/node_modules ./node_modules

# Copy all source (workspace package symlinks now resolve: node_modules/@tiwi/* → packages/*)
COPY . .

# NEXT_PUBLIC_* vars are embedded into the client bundle at build time.
# Pass your Clerk publishable key via: --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter @tiwi/frontoffice build

# ─── Stage 3: Runtime ────────────────────────────────────────────────────────
# The standalone output is self-contained — includes only necessary node_modules.
FROM node:22-alpine AS runner

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# standalone/ mirrors the monorepo structure because outputFileTracingRoot
# is set to the repo root in next.config.ts.
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontoffice/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontoffice/.next/static     ./apps/frontoffice/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/frontoffice/public           ./apps/frontoffice/public

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# server.js is at apps/frontoffice/server.js relative to the standalone root
CMD ["node", "apps/frontoffice/server.js"]
