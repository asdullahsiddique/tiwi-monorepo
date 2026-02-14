import { GetObjectCommand } from "@aws-sdk/client-s3";
import OpenAI from "openai";
import { nanoid } from "nanoid";
import {
  ArtifactRepository,
  createNeo4jDriver,
  EmbeddingRepository,
  ensureNeo4jSchema,
  FileRepository,
  LogRepository,
  TypeRegistryRepository,
} from "@tiwi/neo4j";
import { createS3Client } from "@tiwi/storage";
import { runFileEnrichment } from "@tiwi/langgraph";
import { getDaemonEnv } from "../env";
import type { ProcessFileV1Payload } from "../jobs/types";

function estimateCostUsd(params: {
  inputTokens: number;
  outputTokens: number;
  priceInputPer1M: number;
  priceOutputPer1M: number;
}): number {
  const input = (params.inputTokens / 1_000_000) * params.priceInputPer1M;
  const output = (params.outputTokens / 1_000_000) * params.priceOutputPer1M;
  return Number((input + output).toFixed(6));
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  if (Buffer.isBuffer(stream)) return stream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function chunkText(text: string, opts: { size: number; overlap: number }): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + opts.size);
    out.push(text.slice(i, end));
    i = end - opts.overlap;
    if (i < 0) i = 0;
    if (end === text.length) break;
  }
  return out;
}

export async function processFileV1(payload: ProcessFileV1Payload): Promise<void> {
  const env = getDaemonEnv();
  const driver = createNeo4jDriver();

  try {
    await ensureNeo4jSchema(driver);

    const fileRepo = new FileRepository(driver);
    const logRepo = new LogRepository(driver);
    const artifactRepo = new ArtifactRepository(driver);
    const embeddingRepo = new EmbeddingRepository(driver);
    const typeRepo = new TypeRegistryRepository(driver);

    const file = await fileRepo.getFile({ orgId: payload.orgId, fileId: payload.fileId });
    if (!file) {
      // Nothing to do; file record missing.
      return;
    }

    const { client: s3, bucket } = createS3Client();
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: file.objectKey }));
    const body = await streamToBuffer(obj.Body);

    // v1 extraction: support text/* and fallback to best-effort UTF-8 decode.
    let extractedText = "";
    if (file.contentType.startsWith("text/") || file.contentType === "application/json") {
      extractedText = body.toString("utf8");
    } else {
      extractedText = body.toString("utf8");
    }

    const trimmed = extractedText.trim();
    const summary =
      trimmed.length === 0
        ? "No extractable text found."
        : trimmed.slice(0, 800) + (trimmed.length > 800 ? "…" : "");

    await artifactRepo.setFileSummary({ orgId: payload.orgId, fileId: payload.fileId, summary });
    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "INFO",
      message: "Extracted text and stored summary",
      metadata: { bytes: body.length, contentType: file.contentType },
    });

    // Embeddings (mandatory for semantic retrieval) — best-effort if OpenAI is configured.
    if (env.OPENAI_API_KEY) {
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const chunks = chunkText(trimmed.slice(0, 100_000), { size: 1200, overlap: 200 });

      for (let idx = 0; idx < chunks.length; idx++) {
        const text = chunks[idx]!;
        const embedding = await openai.embeddings.create({
          model: env.OPENAI_EMBEDDING_MODEL,
          input: text,
        });

        const vector = embedding.data[0]?.embedding ?? [];
        const promptTokens = (embedding as any).usage?.prompt_tokens ?? 0;
        const totalTokens = (embedding as any).usage?.total_tokens ?? promptTokens;

        await embeddingRepo.upsertEmbeddingChunk({
          orgId: payload.orgId,
          fileId: payload.fileId,
          chunkId: `${payload.fileId}:${idx}`,
          index: idx,
          text,
          model: env.OPENAI_EMBEDDING_MODEL,
          createdAtIso: new Date().toISOString(),
          vector,
        });

        await logRepo.appendAIExecutionLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          model: env.OPENAI_EMBEDDING_MODEL,
          inputTokens: promptTokens,
          outputTokens: 0,
          totalTokens,
          costUsd: estimateCostUsd({
            inputTokens: promptTokens,
            outputTokens: 0,
            priceInputPer1M: env.OPENAI_PRICE_INPUT_PER_1M_USD,
            priceOutputPer1M: env.OPENAI_PRICE_OUTPUT_PER_1M_USD,
          }),
          purpose: "embeddings:chunk",
          metadata: { chunkIndex: idx },
        });
      }

      await logRepo.appendProcessingLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        level: "INFO",
        message: "Generated embeddings",
        metadata: { chunks: chunks.length },
      });
    } else {
      await logRepo.appendProcessingLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        level: "WARN",
        message: "OPENAI_API_KEY not set; skipping embeddings generation",
      });
    }

    // LangGraph enrichment (best-effort; returns empty if no key).
    const enrichment = await runFileEnrichment({
      orgId: payload.orgId,
      userId: payload.userId,
      fileId: payload.fileId,
      text: trimmed.slice(0, 25_000),
      typeRegistryStore: {
        getType: async ({ orgId, typeName }) => {
          const t = await typeRepo.getType({ orgId, typeName });
          if (!t) return null;
          return {
            typeName: t.typeName,
            description: t.description,
            createdBy: t.createdBy,
            createdAtIso: t.createdAt,
          };
        },
        createType: async ({ orgId, typeName, description, createdBy }) => {
          await typeRepo.createType({ orgId, typeName, description, createdBy });
        },
      },
    });

    for (const d of enrichment.decisions) {
      await logRepo.appendProcessingLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        level: d.level === "WARN" ? "WARN" : "INFO",
        message: d.message,
        metadata: d.metadata,
      });
    }

    for (const ai of enrichment.aiCalls) {
      await logRepo.appendAIExecutionLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        model: ai.model,
        inputTokens: ai.inputTokens,
        outputTokens: ai.outputTokens,
        totalTokens: ai.totalTokens,
        costUsd: ai.costUsd,
        purpose: ai.purpose,
        metadata: { createdAtIso: ai.createdAtIso },
      });
    }

    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "INFO",
      message: "LangGraph enrichment complete",
      metadata: {
        entities: enrichment.entities.length,
        relationships: enrichment.relationships.length,
        createdTypes: enrichment.createdTypes.length,
      },
    });
  } finally {
    await driver.close();
  }
}

