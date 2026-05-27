# Daemon Processing Pipeline

This document describes the current file-processing pipeline implemented in `@tiwi/daemon` (`apps/daemon`). It is a snapshot of what the code does today — not a design proposal.

## 1. High-level shape

```
MongoDB queue (file_processing_jobs)
        │
        ▼
┌────────────────────┐
│ apps/daemon worker │  poll every 60s, concurrency 2
└────────┬───────────┘
         │ claim job → set file status = PROCESSING
         ▼
┌──────────────────────────────────────────────┐
│ Route by payload.documentType                │
│   • "grand_prix_result" → processGrandPrixResultsV1
│   • otherwise           → processFileV1     │
└──────────────────────────────────────────────┘
         │
         ▼
   mark job processed / failed
   file status = PROCESSED / FAILED
```

All work is multi-tenant: every read/write is scoped by `orgId` (and `userId` when relevant), in line with the workspace non-negotiables.

## 2. Entry point and worker loop

- `src/index.ts` loads `.env` files (local + monorepo root) and calls `startWorker()`.
- `src/worker.ts` is the polling worker:
  - `POLL_MS = 60_000` (one poll every 60s).
  - `CONCURRENCY = 2` (two parallel "pumps" drain the queue until empty).
  - Each pump calls `claimNextFileJob(db)` from `@tiwi/mongodb`, which is a `findOneAndUpdate` on `file_processing_jobs` that atomically flips `status: "queued"` → `status: "processing"` (sorted by `createdAt` ascending — FIFO).
  - On each claim:
    1. `FileRepository.updateStatus({ status: "PROCESSING" })`.
    2. Append a `processing_logs` entry "Started processing job".
    3. Dispatch to the right processor based on `payload.documentType`.
    4. On success → `markFileJobProcessed`, file status `PROCESSED`, "Processing pipeline complete" log.
    5. On error → `markFileJobFailed(jobId, errorMessage)`, file status `FAILED` with `failureReason`, ERROR log with stack + (for Zod) per-issue details.
- `configureLangSmith()` is called once at startup so LangGraph runs in the F1 enrichment graph are traceable.
- `SIGINT` triggers `closeMongoClient()` then `process.exit(0)`.

The queue itself lives in MongoDB (`COLL.fileProcessingJobs = "file_processing_jobs"`), produced by the frontoffice when a file is uploaded. The daemon never talks to S3/R2 directly to find work — it only consumes the Mongo queue.

## 3. Job payload

`ProcessFileV1Payload` (in `src/jobs/types.ts`) is the unit of work the processors see:

```ts
{
  orgId: string;
  userId: string;
  fileId: string;
  objectKey: string;        // S3/MinIO/R2 key
  contentType: string;      // MIME
  originalName: string;
  documentType?: DocumentType; // optional routing hint
}
```

## 4. Two processors

### 4a. `processFileV1` — generic multi-modal pipeline

Used for every job that does NOT have `documentType === "grand_prix_result"`. This is the workhorse.

Object storage access goes through `@tiwi/storage` (`createS3Client` / `createPresignedGetUrl`), so the same code path serves MinIO locally and Cloudflare R2 in staging/prod.

The processor has three explicit stages.

#### Stage 1 — Extraction (branch by content type)

The MIME type is normalised via four predicates: `isDocumentFile`, `isImageFile`, `isVideoFile`, `isAudioFile`, `isTextBasedFile`. The branches:

| Branch | Trigger | Provider / model | Output |
|---|---|---|---|
| Video / Audio | `video/*` or `audio/*` (+ `ASSEMBLYAI_API_KEY`) | AssemblyAI `transcripts.transcribe` with `speaker_labels: true, auto_chapters: true`, using a 2-hour presigned GET URL | `extractedText` = transcript, `summary` = formatted chapter list with `[mm:ss] headline` + chapter summary |
| Document (PDF / DOC / DOCX / PPT / PPTX) | `isDocumentFile()` (+ `OPENAI_API_KEY`) | GPT-5 via the **Responses API** (`input_file` + `input_text`), 600s client timeout | Verbatim extracted text (incl. GitHub-flavoured markdown tables) |
| &nbsp;&nbsp;↳ PDF > 15 pages | `PAGES_PER_CHUNK = 15`, split with `pdf-lib` | Same GPT-5 Responses API, **once per 15-page chunk**, prompt prefixed with `"Pages X–Y of Z."` | Per-chunk text joined with `\n\n` |
| Image | `image/*` (+ `OPENAI_API_KEY`) | GPT-5 via **Chat Completions** with `image_url` + `response_format: "text"` | Verbatim text from the image |
| Text-based | `text/*`, `application/json`, `application/xml`, `application/javascript` | Buffer → `toString("utf8")` (no AI call for extraction) | Raw file content |
| Unsupported | anything else | — | `extractedText = ""`, summary = "Unsupported file type…" warning logged |

Notes on the document branch:
- PDFs are speculatively chunked first (`splitPdfIntoChunks`). Encrypted/corrupted PDFs throw inside `PDFDocument.load(...)`, which is caught and the code falls through to the single-shot path.
- Every Responses API call is wrapped in `withHeartbeat(label, meta, fn, 30_000)` which logs "<label> — still waiting" every 30s so long uploads don't look dead.
- Per-chunk failures are downgraded to a `WARN` processing log and the chunk's text is just dropped — the rest of the document continues.

#### Stage 1b — Summarisation (document & image only)

For document + image branches a second AI call produces `summary`:

| Condition | Model | API | Purpose log tag |
|---|---|---|---|
| Documents with `extractedText.length > 300` | `gpt-5-mini` | Chat Completions, `max_tokens: 600`, prompt = "Summarize the provided text in 2-3 clear paragraphs…" | `summarization:document` |
| Documents with thin text (≤ 300 chars, image-heavy) | `gpt-5` | Responses API on the **first PDF chunk** (or full body if not chunked) — "Describe the content of this document in 2-3 paragraphs…" | `summarization:document:visual` |
| Images | `gpt-5-mini` | Chat Completions on the extracted text (or "An image with minimal or no text content.") | `summarization:image` |
| Text-based files | `OPENAI_SUMMARIZATION_MODEL` (default `gpt-5-mini`) | Chat Completions, "Create a clear, comprehensive 2-3 paragraph summary…" | `summarization:text` |
| Video/audio | — | No separate summary call; `summary` is built from AssemblyAI chapters | — |

Summary fallback: if a summary call throws, the code falls back to `extractedText.slice(0, 800) + "…"` (or `"Document is primarily visual…"` / `"Image content could not be summarized."`).

#### Stage 2 — Persistence + embeddings

1. Choose enrichment source: `textForEnrichment = extractedText.trim().length > 100 ? extractedText.trim() : summary`. Image-heavy docs effectively get enriched off the summary.
2. `ArtifactRepository.setFileSummary({ orgId, fileId, summary })`.
3. If `OPENAI_API_KEY` is set:
   - `EmbeddingRepository.deleteChunksForFile(...)` (re-embed cleanly on reprocess) — wipes **both** Mongo (`embedding_chunks`) and Pinecone (list-by-prefix `${fileId}:` then `deleteMany(ids)` in 1000-ID batches; serverless Pinecone doesn't support `deleteMany({ filter })`).
   - `chunkText(textForEnrichment.slice(0, 100_000), { size: 1200, overlap: 200 })`.
   - For each chunk: one `openai.embeddings.create({ model: OPENAI_EMBEDDING_MODEL })` call (default `text-embedding-3-small`) → `EmbeddingRepository.upsertEmbeddingChunk(...)` with `chunkId = "${fileId}:${idx}"`. Internally the repo writes the chunk **text + metadata** to Mongo (`COLL.embeddingChunks`) and the **vector + `{orgId, fileId, chunkIndex}` metadata** to Pinecone (`PINECONE_INDEX`, default `"tiwi"`), keyed on the same `chunkId`.
   - Every embedding call is also logged via `LogRepository.appendAIExecutionLog` with `purpose: "embeddings:chunk"`.

This matches the core non-negotiable: vectors in Pinecone, chunk text in Mongo, linked by `chunkId`. Vector search (`EmbeddingRepository.querySimilarChunks`) queries Pinecone with `filter: { orgId: { $eq: orgId } }` and hydrates the matched `chunkId`s from Mongo to recover text.

#### Stage 3 — F1 entity enrichment (`@tiwi/enrichment`, LangGraph)

`runFileEnrichment({ orgId, fileId, text: enrichmentText.slice(0, 25_000), sourceChunkIds, lookupStore })` runs an 8-node LangGraph (see `packages/enrichment/src/graph.ts`):

```
START → extractDrivers
      → extractConstructorsAndSeats
      → extractCircuitsAndSeasons
      → extractGrandsPrix
      → extractResults
      → extractIncidentsAndPenalties
      → extractMediaEntities
      → validateOutput
      → END
```

The `lookupStore` (built from `F1Repository`) lets each node resolve names/aliases to existing canonical entity IDs **scoped to `orgId`**, so e.g. a "Max" mentioned in this file resolves to the existing Verstappen entityId.

The daemon then persists drafts in strict dependency order, remapping FK IDs against an `idMap` populated as canonical IDs come back from upsert:

- Tier 1 (reference entities): `drivers` → `constructors` → `circuits` → `seasons` → `teamPrincipals` (FK: constructor) → `grandsPrix` (FK: season, circuit) → `driverSeats` (FK: driver, constructor, season).
- Tier 2 (per-race facts): `raceResults`, `qualifyingResults`, `sprintResults`, `pitStops`.
- Tier 3 (events): `incidents`, `penalties`.
- Tier 4 (media / soft entities): `cars`, `tyreCompounds`, `quotes`, `transferRumours`.

Each fact upsert is gated on `firstProv(d)` — drafts without provenance are silently skipped. `driverSeats` are also skipped if `driverId` or `constructorId` failed to resolve.

The enrichment result also surfaces:
- `decisions[]` → each becomes a `processing_logs` entry (`INFO`/`WARN`).
- `errors[]` → ERROR logs both to stdout and `processing_logs`.
- `aiCalls[]` → forwarded to `LogRepository.appendAIExecutionLog` with the model/tokens/cost the graph reports.

The pipeline ends with a single "Processing pipeline complete" log carrying the totals per entity type.

### 4b. `processGrandPrixResultsV1` — specialised GP results extractor

Used only when `payload.documentType === "grand_prix_result"`. It is intentionally narrow.

- Validates `ANTHROPIC_API_KEY` via a local Zod schema (the daemon `env.ts` only treats it as optional).
- Downloads the file from S3/R2 via `@tiwi/storage` (same path as `processFileV1`).
- Builds an Anthropic message:
  - `image/*` → `{ type: "image", source: base64 }`.
  - `application/pdf` → `{ type: "document", source: base64 }`.
  - Anything else throws — only PDFs and images are supported here.
- Calls `anthropic.messages.stream({ model: "claude-opus-4-7", max_tokens: 4096, ... }).finalMessage()` with a strict "return JSON only" system prompt and a detailed user prompt that specifies the exact output shape (`grandPrix`, `circuit`, `country`, `dateStart`, `dateEnd`, `results[]`).
- Parses the response: strips ``` fences if present, slices between first `{` and last `}`, runs `JSON.parse`, then validates against `GpResultExtractionSchema` (Zod). `position` is `number | string` (DNF / DNS rows); numeric fields are nullable.
- Persists via `GpResultRepository.upsertForFile({ orgId, fileId, grandPrix, circuit, country, dateStart, dateEnd, results })` — note this writes to the `gp_race_results` collection, separate from the generic F1 entities.
- Logs one `ai_execution_logs` entry with `purpose: "gp_results:extract"` (currently `costUsd: 0` — no pricing computed for Claude Opus 4.7 yet).

This processor does **not** run the F1 enrichment graph, does not generate embeddings, and does not write a summary artifact. It's a pure extract-and-store flow.

## 5. Observability & logging

The pipeline writes to three places per job:

1. **stdout (structured JSON)** — every `log()` call emits `{ ts, level, message, fileId, ... }` lines. ERROR also goes to stderr. Used for container logs.
2. **`processing_logs` collection** (`LogRepository.appendProcessingLog`) — narrative timeline visible per file in the UI.
3. **`ai_execution_logs` collection** (`LogRepository.appendAIExecutionLog`) — required by the core non-negotiables: every AI call records `model`, `inputTokens`, `outputTokens`, `totalTokens`, `costUsd`, `purpose`, timestamp, `orgId`, `fileId`.

`purpose` tags currently emitted:

- `transcription:video`
- `extraction:document`, `extraction:document:chunk`, `extraction:image`
- `summarization:document`, `summarization:document:visual`, `summarization:image`, `summarization:text`
- `embeddings:chunk`
- `gp_results:extract`
- Plus whatever the enrichment graph nodes emit internally.

Pricing currently uses two hardcoded constants in `processFileV1`:

```ts
const GPT4O_PRICE      = { input: 2.5,  output: 10  }; // $/1M tokens
const GPT4O_MINI_PRICE = { input: 0.15, output: 0.6 }; // $/1M tokens
```

These are applied to GPT-5 and GPT-5-mini calls (the constant names are stale labels). AssemblyAI cost is approximated as `durationHours * 0.37`. Anthropic cost is 0.

## 6. Environment (`src/env.ts`)

Required:
- `MONGODB_URI` (defaults to `mongodb://localhost:27017/tiwi`).
- `PINECONE_API_KEY`, `PINECONE_INDEX` — read by `@tiwi/mongodb`'s `pinecone.ts` (lazy singleton). Used transitively by `EmbeddingRepository` to upsert/query/delete vectors during Stage 2 embeddings.

Optional (each unlocks a branch):
- `OPENAI_API_KEY` — required for document/image/text summaries, embeddings, and the F1 enrichment graph (`runFileEnrichment` early-returns empty without it).
- `ANTHROPIC_API_KEY` — required only for `processGrandPrixResultsV1`.
- `ASSEMBLYAI_API_KEY` — required for video/audio transcription; without it the file is logged as a WARN and gets a placeholder summary.

Tunables:
- `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`).
- `OPENAI_SUMMARIZATION_MODEL` (default `gpt-5-mini`) — only used in the text-based branch.
- `OPENAI_PRICE_INPUT_PER_1M_USD`, `OPENAI_PRICE_OUTPUT_PER_1M_USD` — only applied to text summarisation + embeddings cost lines; the document/image branches use the hardcoded constants above.

LangSmith (optional): `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`, `LANGSMITH_PROJECT` — wired up at worker startup via `configureLangSmith()`.

## 7. Runtime / deployment

`Dockerfile` runs the worker as `pnpm exec tsx src/index.ts` against the monorepo workspace (no pre-compiled build — all workspace packages export raw TS via `main: ./src/index.ts`). Two stages: `deps` (install with `pnpm install --frozen-lockfile`) and runtime (copy `node_modules` from `deps` + source on top).

Locally the daemon is started via `docker compose up`, satisfying the "local-first via docker compose, MinIO for object storage" non-negotiable.

## 8. Concrete observations / open questions

These are things I noticed while tracing the code that the team may want to address:

1. **Hardcoded GPT-4o pricing applied to GPT-5 / GPT-5-mini calls.** The constants `GPT4O_PRICE` and `GPT4O_MINI_PRICE` are stale-named and likely inaccurate for GPT-5. Either replace with current GPT-5 prices or switch to `OPENAI_PRICE_INPUT_PER_1M_USD` / `OPENAI_PRICE_OUTPUT_PER_1M_USD` env vars (today those env vars only affect the text + embedding branches).
2. **Anthropic call has `costUsd: 0`.** `processGrandPrixResultsV1` does not compute cost; combined with the GPT-4o constants above, the cost dashboard will under-report.
3. **Embedding upsert is a dual write with no transaction.** `EmbeddingRepository.upsertEmbeddingChunk` writes to Mongo then to Pinecone. If the Pinecone call fails after the Mongo write succeeds, the two stores drift (Mongo has chunk text but no vector). Worth a small reconciliation/sweep mechanism, or at minimum retries.
4. **Polling latency.** With `POLL_MS = 60_000` and `CONCURRENCY = 2`, a job uploaded just after a poll waits up to 60s before pickup. Fine for now, but if the queue grows or latency matters we should consider MongoDB change streams or a shorter poll interval.
5. **`claimNextFileJob` has no lease / heartbeat.** A daemon crash mid-job leaves the job in `status: "processing"` forever. Worth adding a `claimedAt` and a re-queue sweeper for stale claims.
6. **Per-chunk PDF failures are silent except in logs.** `processFileV1` drops failed chunks and keeps going — the file is still marked PROCESSED. If we want a strict mode (any chunk failure → file FAILED) we should make that explicit.
7. **F1 enrichment hard-caps text at 25k chars** before the graph and 50k inside `runFileEnrichment` (`text.slice(0, 50_000)`). Long transcripts will be truncated for entity extraction even though we generate embeddings off the first 100k.
