import { GetObjectCommand } from "@aws-sdk/client-s3";
import OpenAI from "openai";
import { AssemblyAI } from "assemblyai";
import { nanoid } from "nanoid";
import {
  ArtifactRepository,
  createNeo4jDriver,
  EmbeddingRepository,
  ensureNeo4jSchema,
  FileRepository,
  LogRepository,
  TypeRegistryRepository,
  EntityRepository,
} from "@tiwi/neo4j";
import { createS3Client, createPresignedGetUrl } from "@tiwi/storage";
import { runFileEnrichment } from "@tiwi/enrichment";
import { getDaemonEnv } from "../env";
import type { ProcessFileV1Payload } from "../jobs/types";

// ---------------------------------------------------------------------------
// Pricing constants
// ---------------------------------------------------------------------------
const GPT4O_PRICE = { input: 2.5, output: 10 }; // per 1M tokens
const GPT4O_MINI_PRICE = { input: 0.15, output: 0.6 }; // per 1M tokens

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// File type detection
// ---------------------------------------------------------------------------

// Document files processed via GPT-4o Responses API (supports binary file upload)
const DOCUMENT_FILE_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.ms-powerpoint", // .ppt
];

// Image files processed via GPT-4o Chat Completions with image_url
const IMAGE_FILE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
];

const VIDEO_FILE_TYPES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/mpeg",
  "video/ogg",
];

const AUDIO_FILE_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/ogg",
  "audio/flac",
  "audio/aac",
  "audio/m4a",
  "audio/webm",
];

function isDocumentFile(contentType: string): boolean {
  return DOCUMENT_FILE_TYPES.includes(contentType);
}

function isImageFile(contentType: string): boolean {
  return IMAGE_FILE_TYPES.includes(contentType) || contentType.startsWith("image/");
}

function isVideoFile(contentType: string): boolean {
  return VIDEO_FILE_TYPES.includes(contentType) || contentType.startsWith("video/");
}

function isAudioFile(contentType: string): boolean {
  return AUDIO_FILE_TYPES.includes(contentType) || contentType.startsWith("audio/");
}

function isTextBasedFile(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/xml" ||
    contentType === "application/javascript"
  );
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
function log(level: "INFO" | "WARN" | "ERROR", message: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, fileId: meta?.fileId, ...meta });
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

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
    const entityRepo = new EntityRepository(driver);

    const file = await fileRepo.getFile({ orgId: payload.orgId, fileId: payload.fileId });
    if (!file) { log("WARN", "File not found, aborting", { fileId: payload.fileId }); return; }

    log("INFO", "Downloading file from S3", { fileId: file.fileId, contentType: file.contentType, objectKey: file.objectKey });
    const { client: s3, bucket } = createS3Client();
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: file.objectKey }));
    const body = await streamToBuffer(obj.Body);
    log("INFO", "File downloaded", { fileId: file.fileId, sizeBytes: body.length });

    let extractedText = "";
    let summary = "";

    // -------------------------------------------------------------------------
    // Stage 1 — Extract text / transcript from the source file
    // -------------------------------------------------------------------------

    if ((isVideoFile(file.contentType) || isAudioFile(file.contentType)) && env.ASSEMBLYAI_API_KEY) {
      // --- Audio / Video: AssemblyAI transcription ---
      const assemblyai = new AssemblyAI({ apiKey: env.ASSEMBLYAI_API_KEY });

      await logRepo.appendProcessingLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        level: "INFO",
        message: "Starting video/audio transcription with AssemblyAI",
        metadata: { contentType: file.contentType, sizeBytes: body.length },
      });

      const presignedUrl = await createPresignedGetUrl({
        objectKey: file.objectKey,
        expiresInSeconds: 7200,
      });

      try {
        const transcript = await assemblyai.transcripts.transcribe({
          audio: presignedUrl,
          speaker_labels: true,
          auto_chapters: true,
        });

        if (transcript.status === "error") {
          throw new Error(`AssemblyAI transcription failed: ${transcript.error}`);
        }

        extractedText = transcript.text ?? "";

        const summaryParts: string[] = [];
        if (transcript.chapters && transcript.chapters.length > 0) {
          for (const chapter of transcript.chapters) {
            const startSecs = Math.floor((chapter.start ?? 0) / 1000);
            const m = Math.floor(startSecs / 60);
            const s = startSecs % 60;
            summaryParts.push(`**[${m}:${s.toString().padStart(2, "0")}] ${chapter.headline}**`);
            if (chapter.summary) summaryParts.push(chapter.summary);
            summaryParts.push("");
          }
        }
        summary = summaryParts.join("\n").trim() || "Transcription complete. No chapters detected.";

        const speakerCount = transcript.utterances
          ? new Set(transcript.utterances.map((u) => u.speaker)).size
          : 0;
        const durationHours = (transcript.audio_duration ?? 0) / 3600;

        await logRepo.appendProcessingLog({
          orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
          level: "INFO",
          message: "AssemblyAI transcription complete",
          metadata: { textLength: extractedText.length, speakerCount, chapterCount: transcript.chapters?.length ?? 0, durationSeconds: transcript.audio_duration ?? 0 },
        });

        await logRepo.appendAIExecutionLog({
          orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
          model: "assemblyai-best",
          inputTokens: 0, outputTokens: 0, totalTokens: 0,
          costUsd: Number((durationHours * 0.37).toFixed(4)),
          purpose: "transcription:video",
          metadata: { durationSeconds: transcript.audio_duration, speakerCount },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logRepo.appendProcessingLog({
          orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
          level: "WARN",
          message: `AssemblyAI transcription failed: ${msg}`,
          metadata: { error: msg },
        });
        extractedText = "";
        summary = `Video/audio transcription failed: ${msg}`;
      }

    } else if ((isVideoFile(file.contentType) || isAudioFile(file.contentType)) && !env.ASSEMBLYAI_API_KEY) {
      extractedText = "";
      summary = "Video/audio file detected but ASSEMBLYAI_API_KEY is not configured.";
      await logRepo.appendProcessingLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        level: "WARN",
        message: "ASSEMBLYAI_API_KEY not set; skipping video/audio transcription",
        metadata: { contentType: file.contentType },
      });

    } else if (isDocumentFile(file.contentType) && env.OPENAI_API_KEY) {
      // --- Documents (PDF, DOCX, PPT): two focused GPT calls ---
      // Timeout set at client level — more reliable than per-request options on `as any` calls
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 180_000 });
      const base64Content = body.toString("base64");
      const dataUrl = `data:${file.contentType};base64,${base64Content}`;

      // Step 1: Extract raw text (GPT-4o, focused — no summarization)
      await logRepo.appendProcessingLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        level: "INFO",
        message: "Step 1/2 — Extracting text from document (GPT-4o)",
        metadata: { contentType: file.contentType, sizeBytes: body.length },
      });

      try {
        log("INFO", "GPT-4o: starting document text extraction", { fileId: file.fileId, sizeBytes: body.length });
        const extractionResponse = await (openai as any).responses.create({
          model: "gpt-4o",
          max_output_tokens: 8000,
          input: [
            {
              role: "user",
              content: [
                { type: "input_file", filename: file.originalName, file_data: dataUrl },
                {
                  type: "input_text",
                  text: "Extract all text verbatim from this document. Return only the raw text content — no commentary, no formatting, no JSON wrapper. If the document is primarily visual/graphical with minimal readable text, return whatever text is visible.",
                },
              ],
            },
          ],
        });

        extractedText = (extractionResponse.output_text ?? "").trim();
        log("INFO", "GPT-4o: document text extraction complete", { fileId: file.fileId, extractedLength: extractedText.length, inputTokens: extractionResponse.usage?.input_tokens, outputTokens: extractionResponse.usage?.output_tokens });

        const inTok = extractionResponse.usage?.input_tokens ?? 0;
        const outTok = extractionResponse.usage?.output_tokens ?? 0;
        await logRepo.appendAIExecutionLog({
          orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
          model: "gpt-4o",
          inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok,
          costUsd: estimateCostUsd({ inputTokens: inTok, outputTokens: outTok, priceInputPer1M: GPT4O_PRICE.input, priceOutputPer1M: GPT4O_PRICE.output }),
          purpose: "extraction:document",
          metadata: { contentType: file.contentType, extractedLength: extractedText.length },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("WARN", "GPT-4o: document text extraction failed", { fileId: file.fileId, error: msg });
        await logRepo.appendProcessingLog({
          orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
          level: "WARN",
          message: `Document text extraction failed: ${msg}`,
          metadata: { error: msg },
        });
        extractedText = "";
      }

      // Step 2: Summarize
      // If we got substantial text → gpt-4o-mini (cheap text summarization)
      // If text is thin (image-heavy doc) → gpt-4o Responses API (visual summary)
      await logRepo.appendProcessingLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        level: "INFO",
        message: `Step 2/2 — Summarizing document (${extractedText.length > 300 ? "gpt-4o-mini on text" : "gpt-4o visual"})`,
        metadata: { extractedTextLength: extractedText.length },
      });

      if (extractedText.length > 300) {
        // Text-based summary — gpt-4o-mini
        try {
          const summaryResponse = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            max_tokens: 600,
            messages: [
              { role: "system", content: "You are a document summarization assistant. Summarize the provided text in 2-3 clear paragraphs covering the key information." },
              { role: "user", content: extractedText.slice(0, 30_000) },
            ],
          });
          summary = summaryResponse.choices[0]?.message?.content ?? "No summary generated.";
          const inTok = summaryResponse.usage?.prompt_tokens ?? 0;
          const outTok = summaryResponse.usage?.completion_tokens ?? 0;
          await logRepo.appendAIExecutionLog({
            orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
            model: "gpt-4o-mini",
            inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok,
            costUsd: estimateCostUsd({ inputTokens: inTok, outputTokens: outTok, priceInputPer1M: GPT4O_MINI_PRICE.input, priceOutputPer1M: GPT4O_MINI_PRICE.output }),
            purpose: "summarization:document",
            metadata: { contentType: file.contentType },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          summary = extractedText.slice(0, 800) + (extractedText.length > 800 ? "…" : "");
          await logRepo.appendProcessingLog({
            orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
            level: "WARN",
            message: `Document summarization failed: ${msg}`,
          });
        }
      } else {
        // Visual summary via GPT-4o Responses API (image-heavy / design doc)
        try {
          const visualSummaryResponse = await (openai as any).responses.create({
            model: "gpt-4o",
            max_output_tokens: 600,
            input: [
              {
                role: "user",
                content: [
                  { type: "input_file", filename: file.originalName, file_data: dataUrl },
                  {
                    type: "input_text",
                    text: "Describe the content of this document in 2-3 paragraphs. Focus on key information, themes, people, organizations, data, and any notable elements you can observe.",
                  },
                ],
              },
            ],
          });
          summary = (visualSummaryResponse.output_text ?? "").trim() || "No summary generated.";
          const inTok = visualSummaryResponse.usage?.input_tokens ?? 0;
          const outTok = visualSummaryResponse.usage?.output_tokens ?? 0;
          await logRepo.appendAIExecutionLog({
            orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
            model: "gpt-4o",
            inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok,
            costUsd: estimateCostUsd({ inputTokens: inTok, outputTokens: outTok, priceInputPer1M: GPT4O_PRICE.input, priceOutputPer1M: GPT4O_PRICE.output }),
            purpose: "summarization:document:visual",
            metadata: { contentType: file.contentType },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          summary = "Document is primarily visual. No text summary available.";
          await logRepo.appendProcessingLog({
            orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
            level: "WARN",
            message: `Visual document summarization failed: ${msg}`,
          });
        }
      }

      await logRepo.appendProcessingLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        level: "INFO",
        message: "Document processing complete",
        metadata: { extractedLength: extractedText.length, summaryLength: summary.length },
      });

    } else if (isImageFile(file.contentType) && env.OPENAI_API_KEY) {
      // --- Images: two focused GPT calls ---
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const base64Content = body.toString("base64");
      const dataUrl = `data:${file.contentType};base64,${base64Content}`;

      // Step 1: Extract visible text from the image (GPT-4o)
      await logRepo.appendProcessingLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        level: "INFO",
        message: "Step 1/2 — Extracting text from image (GPT-4o)",
        metadata: { contentType: file.contentType, sizeBytes: body.length },
      });

      try {
        const extractionResponse = await openai.chat.completions.create({
          model: "gpt-4o",
          max_tokens: 4000,
          response_format: { type: "text" },
          messages: [
            { role: "system", content: "Extract all visible text from the provided image verbatim. Return only the raw text — no commentary, no formatting." },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: dataUrl } },
                { type: "text", text: "Extract all visible text from this image." },
              ],
            },
          ],
        });
        extractedText = (extractionResponse.choices[0]?.message?.content ?? "").trim();
        const inTok = extractionResponse.usage?.prompt_tokens ?? 0;
        const outTok = extractionResponse.usage?.completion_tokens ?? 0;
        await logRepo.appendAIExecutionLog({
          orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
          model: "gpt-4o",
          inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok,
          costUsd: estimateCostUsd({ inputTokens: inTok, outputTokens: outTok, priceInputPer1M: GPT4O_PRICE.input, priceOutputPer1M: GPT4O_PRICE.output }),
          purpose: "extraction:image",
          metadata: { contentType: file.contentType, extractedLength: extractedText.length },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logRepo.appendProcessingLog({
          orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
          level: "WARN",
          message: `Image text extraction failed: ${msg}`,
        });
        extractedText = "";
      }

      // Step 2: Summarize with gpt-4o-mini
      await logRepo.appendProcessingLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        level: "INFO",
        message: "Step 2/2 — Summarizing image content (gpt-4o-mini)",
      });

      const imageTextForSummary = extractedText.length > 50
        ? extractedText
        : "An image with minimal or no text content.";

      try {
        const summaryResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          max_tokens: 600,
          messages: [
            { role: "system", content: "Summarize the following content extracted from an image in 1-2 paragraphs." },
            { role: "user", content: imageTextForSummary.slice(0, 10_000) },
          ],
        });
        summary = summaryResponse.choices[0]?.message?.content ?? "No summary generated.";
        const inTok = summaryResponse.usage?.prompt_tokens ?? 0;
        const outTok = summaryResponse.usage?.completion_tokens ?? 0;
        await logRepo.appendAIExecutionLog({
          orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
          model: "gpt-4o-mini",
          inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok,
          costUsd: estimateCostUsd({ inputTokens: inTok, outputTokens: outTok, priceInputPer1M: GPT4O_MINI_PRICE.input, priceOutputPer1M: GPT4O_MINI_PRICE.output }),
          purpose: "summarization:image",
          metadata: { contentType: file.contentType },
        });
      } catch (err) {
        summary = extractedText.slice(0, 500) || "Image content could not be summarized.";
      }

      await logRepo.appendProcessingLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        level: "INFO",
        message: "Image processing complete",
        metadata: { extractedLength: extractedText.length, summaryLength: summary.length },
      });

    } else if (isTextBasedFile(file.contentType)) {
      // --- Plain text: read buffer, summarize with gpt-4o-mini ---
      extractedText = body.toString("utf8").trim();

      if (env.OPENAI_API_KEY && extractedText.length > 0) {
        const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
        try {
          const summaryResponse = await openai.chat.completions.create({
            model: env.OPENAI_SUMMARIZATION_MODEL,
            max_tokens: 600,
            messages: [
              { role: "system", content: "You are a document summarization assistant. Create a clear, comprehensive 2-3 paragraph summary of the provided text." },
              { role: "user", content: extractedText.slice(0, 30_000) },
            ],
          });
          summary = summaryResponse.choices[0]?.message?.content ?? "No summary generated.";
          const inTok = summaryResponse.usage?.prompt_tokens ?? 0;
          const outTok = summaryResponse.usage?.completion_tokens ?? 0;
          await logRepo.appendAIExecutionLog({
            orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
            model: env.OPENAI_SUMMARIZATION_MODEL,
            inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok,
            costUsd: estimateCostUsd({ inputTokens: inTok, outputTokens: outTok, priceInputPer1M: env.OPENAI_PRICE_INPUT_PER_1M_USD, priceOutputPer1M: env.OPENAI_PRICE_OUTPUT_PER_1M_USD }),
            purpose: "summarization:text",
          });
        } catch (err) {
          summary = extractedText.slice(0, 800) + (extractedText.length > 800 ? "…" : "");
        }
      } else {
        summary = extractedText.length === 0
          ? "No extractable text found."
          : extractedText.slice(0, 800) + (extractedText.length > 800 ? "…" : "");
      }

      await logRepo.appendProcessingLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        level: "INFO",
        message: "Text extraction complete",
        metadata: { bytes: body.length, contentType: file.contentType },
      });

    } else {
      // --- Unsupported ---
      extractedText = "";
      summary = `Unsupported file type: ${file.contentType}. Unable to extract text.`;
      await logRepo.appendProcessingLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        level: "WARN",
        message: `Unsupported file type for text extraction: ${file.contentType}`,
        metadata: { contentType: file.contentType },
      });
    }

    // -------------------------------------------------------------------------
    // Stage 2 — Persist summary + generate embeddings
    // -------------------------------------------------------------------------

    // For image-heavy documents, use summary as enrichment text when extracted text is thin
    const textForEnrichment = extractedText.trim().length > 100
      ? extractedText.trim()
      : summary;

    log("INFO", "Stage 2: persisting summary and generating embeddings", { fileId: file.fileId, extractedLength: extractedText.length, summaryLength: summary.length, enrichmentSource: extractedText.trim().length > 100 ? "extractedText" : "summary" });
    await artifactRepo.setFileSummary({ orgId: payload.orgId, fileId: payload.fileId, summary });

    if (env.OPENAI_API_KEY) {
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const chunks = chunkText(textForEnrichment.slice(0, 100_000), { size: 1200, overlap: 200 });

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
          orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
          model: env.OPENAI_EMBEDDING_MODEL,
          inputTokens: promptTokens, outputTokens: 0, totalTokens,
          costUsd: estimateCostUsd({ inputTokens: promptTokens, outputTokens: 0, priceInputPer1M: env.OPENAI_PRICE_INPUT_PER_1M_USD, priceOutputPer1M: env.OPENAI_PRICE_OUTPUT_PER_1M_USD }),
          purpose: "embeddings:chunk",
          metadata: { chunkIndex: idx },
        });
      }

      await logRepo.appendProcessingLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        level: "INFO",
        message: "Generated embeddings",
        metadata: { chunks: chunks.length, source: extractedText.trim().length > 100 ? "extractedText" : "summary" },
      });
    } else {
      await logRepo.appendProcessingLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        level: "WARN",
        message: "OPENAI_API_KEY not set; skipping embeddings generation",
      });
    }

    // -------------------------------------------------------------------------
    // Stage 3 — Entity & relationship enrichment (LangGraph)
    // -------------------------------------------------------------------------

    const allRegisteredTypes = await typeRepo.listTypes({ orgId: payload.orgId });
    const activeTypes = allRegisteredTypes.filter((t) => t.status === "active");
    const existingTypes = await entityRepo.getAllEntityTypes({ orgId: payload.orgId });
    const existingEntities = await entityRepo.getEntitiesSummary({ orgId: payload.orgId, limit: 200 });

    log("INFO", "Stage 3: starting LangGraph enrichment", { fileId: file.fileId, textLength: textForEnrichment.slice(0, 25_000).length, activeTypes: activeTypes.length, existingEntities: existingEntities.length });

    await logRepo.appendProcessingLog({
      orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
      level: "INFO",
      message: "Starting entity enrichment",
      metadata: {
        textLength: textForEnrichment.slice(0, 25_000).length,
        activeTypes: activeTypes.length,
        existingEntities: existingEntities.length,
      },
    });

    const enrichment = await runFileEnrichment({
      orgId: payload.orgId,
      userId: payload.userId,
      fileId: payload.fileId,
      text: textForEnrichment.slice(0, 25_000),
      typeRegistryStore: {
        getType: async ({ orgId, typeName }) => {
          const t = await typeRepo.getType({ orgId, typeName });
          if (!t) return null;
          return { typeName: t.typeName, description: t.description, createdBy: t.createdBy, createdAtIso: t.createdAt };
        },
        createType: async ({ orgId, typeName, description }) => {
          await typeRepo.createType({ orgId, typeName, description, status: "draft", createdBy: "ai", properties: [] });
        },
      },
      context: {
        existingTypes: activeTypes.map((t) => ({
          typeName: t.typeName,
          description: t.description,
          properties: t.properties,
          entityCount: existingTypes.find((et) => et.typeName === t.typeName)?.entityCount,
        })),
        existingEntities: existingEntities.map((e) => ({
          entityId: e.entityId,
          typeName: e.typeName,
          name: e.name,
          mentionCount: e.mentionCount,
        })),
      },
    });

    for (const d of enrichment.decisions) {
      await logRepo.appendProcessingLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        level: d.level === "WARN" ? "WARN" : "INFO",
        message: d.message,
        metadata: d.metadata,
      });
    }

    for (const ai of enrichment.aiCalls) {
      await logRepo.appendAIExecutionLog({
        orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
        model: ai.model,
        inputTokens: ai.inputTokens, outputTokens: ai.outputTokens, totalTokens: ai.totalTokens,
        costUsd: ai.costUsd,
        purpose: ai.purpose,
        metadata: { createdAtIso: ai.createdAtIso },
      });
    }

    // Register AI-discovered types as drafts
    for (const newType of enrichment.createdTypes) {
      try {
        await typeRepo.createType({
          orgId: payload.orgId,
          typeName: newType.typeName,
          description: newType.description,
          status: "draft",
          createdBy: "ai",
          properties: newType.suggestedProperties ?? [],
        });
        await logRepo.appendProcessingLog({
          orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
          level: "INFO",
          message: `Registered draft entity type: ${newType.typeName}`,
          metadata: { description: newType.description },
        });
      } catch {
        // Type may already exist — fine
      }
    }

    // Persist entities
    for (const entity of enrichment.entities) {
      const entityId = entity.matchedExistingEntityId ?? nanoid();
      await entityRepo.upsertEntity({
        orgId: payload.orgId,
        entityId,
        typeName: entity.typeName,
        name: entity.name,
        properties: entity.properties,
        sourceFileId: payload.fileId,
        confidence: entity.confidence,
      });
    }

    // Persist relationships
    for (const rel of enrichment.relationships) {
      await entityRepo.upsertRelationship({
        orgId: payload.orgId,
        relationshipId: nanoid(),
        fromTypeName: rel.fromTypeName,
        fromName: rel.fromName,
        toTypeName: rel.toTypeName,
        toName: rel.toName,
        relationshipType: rel.relationshipType,
        properties: rel.properties,
        sourceFileId: payload.fileId,
      });
    }

    log("INFO", "Processing pipeline complete", {
      fileId: file.fileId,
      entities: enrichment.entities.length,
      relationships: enrichment.relationships.length,
      draftTypes: enrichment.createdTypes.length,
      resolvedMatches: enrichment.resolvedMatches?.length ?? 0,
    });

    await logRepo.appendProcessingLog({
      orgId: payload.orgId, fileId: payload.fileId, logId: nanoid(),
      level: "INFO",
      message: "Processing pipeline complete",
      metadata: {
        entities: enrichment.entities.length,
        relationships: enrichment.relationships.length,
        draftTypes: enrichment.createdTypes.length,
        resolvedMatches: enrichment.resolvedMatches?.length ?? 0,
      },
    });

  } finally {
    await driver.close();
  }
}
