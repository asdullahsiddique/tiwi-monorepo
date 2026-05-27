# Daemon Processing Pipeline

This document describes the current file-processing pipeline implemented in `@tiwi/daemon` (`apps/daemon`). It is a snapshot of what the code does today.

## 1. High-level shape

```text
MongoDB queue (file_processing_jobs)
        |
        v
apps/daemon worker (poll every 60s, concurrency 2)
        |
        v
processFileV2 (single processor for all jobs)
        |
        +-- PDF / image / converted Office docs -> Claude Agent SDK
        +-- audio / video -> AssemblyAI
        +-- text / json / xml / javascript -> UTF-8 buffer read
        |
        v
Persist extracted text, summary, GP rounds, processing logs, AI logs
        |
        v
Run F1 enrichment graph from extracted text / summary
        |
        v
Mongo text search over files.extractedText
```

The worker no longer routes on `payload.documentType`. The field is preserved on the job payload as an informational hint, but every job is processed by `processFileV2`.

All reads and writes remain scoped by `orgId` (and `userId` where applicable).

## 2. Entry point and worker loop

- `src/index.ts` loads `.env` files and calls `startWorker()`.
- `src/worker.ts` polls MongoDB every 60 seconds with concurrency 2.
- Each claimed job:
  1. sets the file status to `PROCESSING`;
  2. appends a `processing_logs` entry;
  3. calls `processFileV2(payload)`;
  4. marks the job/file `PROCESSED` on success;
  5. marks the job/file `FAILED` on error, including Zod validation details where available.

The queue lives in MongoDB (`file_processing_jobs`) and is populated by the frontoffice upload flow.

## 3. Job payload

`ProcessFileV1Payload` remains the payload type for backward compatibility:

```ts
{
  orgId: string;
  userId: string;
  fileId: string;
  objectKey: string;
  contentType: string;
  originalName: string;
  documentType?: DocumentType;
}
```

`documentType` no longer chooses a processor. The daemon infers processing behavior from `contentType`.

## 4. Unified processor: processFileV2

`src/processors/processFileV2.ts` is the only daemon file processor.

### 4a. Source handling

| Input | Path |
| --- | --- |
| `application/pdf` | staged as `./source.pdf` and sent to the Claude agent |
| DOC/DOCX/PPT/PPTX | written to the workdir, converted with `libreoffice --headless --convert-to pdf`, then sent to the Claude agent as `./source.pdf` |
| `image/*` | staged as `./source.<ext>` and sent to the Claude agent |
| `audio/*`, `video/*` | transcribed with AssemblyAI when `ASSEMBLYAI_API_KEY` is configured |
| text/json/xml/javascript | read directly from the object buffer as UTF-8 |
| unsupported | summary notes the unsupported type and result rounds are cleared |

The daemon Docker image installs both `poppler-utils` and `libreoffice` so the agent can render PDFs and the daemon can convert Office documents.

### 4b. Claude Agent SDK document extraction

For PDFs, converted Office docs, and images, the processor creates an isolated workdir and copies:

- `./source.*`
- `./SKILL.md`
- optional `./schema.md`

It runs `@anthropic-ai/claude-agent-sdk` with:

```ts
{
  cwd: workDir,
  model: env.CLAUDE_AGENT_MODEL,
  maxTurns: env.CLAUDE_AGENT_MAX_TURNS,
  permissionMode: "acceptEdits",
  allowedTools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "Task"],
}
```

The agent must produce two files:

- `rounds.json`: a JSON array of `RoundResult` objects. Empty array means no result tables were found.
- `text.md`: markdown extracted from narrative / non-result-table content. Empty string means no useful narrative text was found.

Mixed-content PDFs are handled page-by-page by `SKILL.md`: result tables are extracted into `rounds.json`, while narrative pages and surrounding non-table prose are preserved in `text.md`.

### 4c. Checkpointing

The processor stores durable agent outputs in object storage:

```text
org/{orgId}/file-processing-checkpoints/{fileId}/unified/rounds.json
org/{orgId}/file-processing-checkpoints/{fileId}/unified/text.md
```

If both checkpoint files exist and `rounds.json` validates, the agent is skipped and the checkpointed outputs are persisted again. Invalid checkpoints are logged as warnings and regenerated.

### 4d. Persistence

For every file:

- `ArtifactRepository.setFileExtractedText(...)` writes `files.extractedText` and `extractedTextUpdatedAt`.
- `ArtifactRepository.setFileSummary(...)` writes `files.summary` and `summaryUpdatedAt`.
- `GpResultRepository.replaceRoundsForFile(...)` replaces all GP result rows for the file. Passing `[]` clears stale rows.
- `processing_logs` captures the user-facing timeline.
- `ai_execution_logs` captures model, tokens, cost estimate, purpose, timestamp, `orgId`, and `fileId` for Claude agent, Claude summary, AssemblyAI, and enrichment calls.

### 4e. Summary

Documents, images, and text files are summarized with Anthropic using `CLAUDE_SUMMARY_MODEL` (default `claude-haiku-4-5`). Audio/video summaries come from AssemblyAI chapters when available.

Pricing uses `estimateAnthropicCostUsd(...)`, including Opus, Sonnet, and Haiku price env vars.

## 5. F1 enrichment

After extraction, the daemon builds:

```ts
const textForEnrichment = extractedText.trim().length > 100
  ? extractedText.trim()
  : summary;
```

It sends the first 25k characters to `runFileEnrichment(...)` from `@tiwi/enrichment`. This LangGraph is unchanged and still uses the enrichment package's OpenAI configuration internally.

Persisted F1 drafts follow the same dependency order as before:

1. reference entities: drivers, constructors, circuits, seasons, team principals, grands prix, driver seats;
2. race facts: race results, qualifying results, sprint results, pit stops;
3. events: incidents, penalties;
4. media / soft entities: cars, tyre compounds, quotes, transfer rumours.

## 6. Search and retrieval

Embeddings and Pinecone are no longer part of the v1 pipeline.

MongoDB creates a text index on `files.extractedText`. `packages/core/src/services/searchTools.ts` implements `search_document_chunks` with Mongo `$text` search and returns `SimilarChunk`-shaped snippets using:

- `chunkId = "{fileId}:text"`
- `model = "mongo-text"`
- `score = textScore`

The frontoffice file view now shows extracted text length and a preview instead of embedding metadata.

## 7. Environment

Daemon env:

Required at runtime for document/image/text summary processing:

- `MONGODB_URI`
- `ANTHROPIC_API_KEY`

Optional branches:

- `ASSEMBLYAI_API_KEY` for audio/video transcription.
- `OPENAI_API_KEY` for the unchanged `@tiwi/enrichment` graph.
- LangSmith variables for enrichment tracing.

Tunables:

- `CLAUDE_AGENT_MODEL` (default `claude-opus-4-7`)
- `CLAUDE_AGENT_MAX_TURNS` (default `200`)
- `CLAUDE_SUMMARY_MODEL` (default `claude-haiku-4-5`)
- `ANTHROPIC_CLAUDE_OPUS_INPUT_USD_PER_1M` / `ANTHROPIC_CLAUDE_OPUS_OUTPUT_USD_PER_1M`
- `ANTHROPIC_CLAUDE_SONNET_INPUT_USD_PER_1M` / `ANTHROPIC_CLAUDE_SONNET_OUTPUT_USD_PER_1M`
- `ANTHROPIC_CLAUDE_HAIKU_INPUT_USD_PER_1M` / `ANTHROPIC_CLAUDE_HAIKU_OUTPUT_USD_PER_1M`

## 8. Observability

The daemon writes to:

1. structured stdout/stderr JSON logs;
2. `processing_logs` for the file timeline;
3. `ai_execution_logs` for token/cost accounting.

Current purpose tags include:

- `document_extraction:agent`
- `summarization:claude`
- `transcription:video`
- enrichment graph purposes emitted by `@tiwi/enrichment`

The Claude agent loop logs assistant turns, tool calls, retry events, task notifications, token accumulation, and final result status.

## 9. Runtime / deployment

The daemon runtime image runs `pnpm exec tsx src/index.ts`. It includes:

- Node 22 Alpine
- `poppler-utils` for PDF rendering
- `libreoffice` for Office-to-PDF conversion

Local development still runs through `docker compose up`, with MinIO as S3-compatible object storage.

## 10. Open operational questions

- `claimNextFileJob` still has no lease / heartbeat, so a daemon crash mid-job can leave work stuck in `processing`.
- Polling latency is still up to 60 seconds.
- Mongo `$text` search is simpler than vector retrieval; if recall quality becomes insufficient, a future embedding provider can be introduced without changing the extraction outputs.
- Office conversion quality should be checked with real DOCX/PPTX samples, especially slide decks with dense visuals.
