# Tiwi Media Intelligence Platform (v1)

MongoDB-backed media intelligence with Pinecone vector search and a polling file-processing worker.

## Repo layout
- `apps/frontoffice`: Next.js (UI + tRPC route handler)
- `apps/daemon`: background worker (polls MongoDB for queued file jobs every 60s)
- `packages/*`: shared libs (MongoDB repos, storage, LangGraph enrichment, etc.)

## Prereqs
- Node.js (recommend latest LTS)
- `pnpm` (repo uses `pnpm@10.x`)
- Docker Desktop (or Docker Engine + Compose v2)
- A **Pinecone** index (cosine, **1536** dimensions for `text-embedding-3-small`) matching `PINECONE_INDEX`

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
- **MongoDB**: `MONGODB_URI` (default in example matches docker-compose)
- **Pinecone**: `PINECONE_API_KEY`, `PINECONE_INDEX`
- **OpenAI** (optional but recommended): `OPENAI_API_KEY`

2) Start infra

```bash
docker compose up --build
```

If `27017` is already in use, set an alternate port in `.env`:

```env
MONGO_PORT=27018
MONGODB_URI=mongodb://localhost:27018/tiwi
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
- **MongoDB**: `mongodb://localhost:${MONGO_PORT:-27017}`
- **MinIO API**: `http://localhost:9000`
- **MinIO Console**: `http://localhost:9001`

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
7. Try `/search` (semantic search + citations)

## Troubleshooting
### MongoDB connection refused
- Ensure `docker compose` is running and `MONGODB_URI` matches the compose port.
### Pinecone errors (upsert/query)
- Verify the index name, API key, and that the index dimension is **1536** with **cosine** similarity.
### MinIO init logs “connection refused”
- This can happen briefly while MinIO is starting; the init container retries and should succeed.

## Security
- Never commit secrets. `.env*` is gitignored (except `.env.example`).
