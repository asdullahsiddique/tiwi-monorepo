# Tiwi Media Intelligence Platform (v1)

Graph-native, agent-driven media intelligence platform.

## Repo layout
- `apps/frontoffice`: Next.js (UI + tRPC route handler)
- `apps/daemon`: background worker (BullMQ)
- `packages/*`: shared libs (Neo4j repos, storage, langgraph, etc.)

## Prereqs
- Node.js (recommend latest LTS)
- `pnpm` (repo uses `pnpm@10.x`)
- Docker Desktop (or Docker Engine + Compose v2)

## Setup (local)
From repo root:

1) Create env files

```bash
cp .env.example .env
cp .env.example apps/frontoffice/.env.local
cp .env.example apps/daemon/.env
```

Fill in at least:
- **Clerk**: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
- **OpenAI** (optional but recommended): `OPENAI_API_KEY`

2) Start infra

```bash
docker compose up --build
```

If `7474` is already in use, set an alternate Neo4j HTTP port in `.env`:

```env
NEO4J_HTTP_PORT=7475
```

If `7687` is in use too:

```env
NEO4J_BOLT_PORT=7688
NEO4J_URI=bolt://localhost:7688
```

3) Install deps

```bash
pnpm install
```

4) Run apps (frontoffice + daemon)

```bash
pnpm dev
```

## URLs (local defaults)
- **Frontoffice**: `http://localhost:3000`
- **Neo4j Browser**: `http://localhost:${NEO4J_HTTP_PORT:-7474}`
- **MinIO API**: `http://localhost:9000`
- **MinIO Console**: `http://localhost:9001`
- **Redis**: `redis://localhost:6379`

## First run flow
1. Go to `http://localhost:3000`
2. Sign up (Clerk)
3. You’ll be redirected to `/onboarding` which **auto-creates an org (random name)** and activates it
4. Land in `/dashboard`
5. Upload a file in `/files`
6. Open the file view at `/files/:fileId` to see:
   - original asset link
   - summary
   - embeddings meta
   - processing logs + AI logs
7. Try `/search` (semantic search + citations)\n+
## Troubleshooting
### Neo4j fails to start due to config validation
- We intentionally keep Neo4j docker config minimal. If you added custom settings, remove/verify them.
### Port already allocated (7474/7687)
- Set `NEO4J_HTTP_PORT` / `NEO4J_BOLT_PORT` in `.env` and keep `NEO4J_URI` in sync.
### MinIO init logs “connection refused”
- This can happen briefly while MinIO is starting; the init container retries and should succeed.
## Security
- Never commit secrets. `.env*` is gitignored (except `.env.example`).
