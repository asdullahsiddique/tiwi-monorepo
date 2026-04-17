import { GetObjectCommand } from "@aws-sdk/client-s3";
import OpenAI from "openai";
import { PDFDocument } from "pdf-lib";
import { AssemblyAI } from "assemblyai";
import { nanoid } from "nanoid";
import {
  ArtifactRepository,
  getMongoDb,
  EmbeddingRepository,
  FileRepository,
  LogRepository,
  F1Repository,
} from "@tiwi/mongodb";
import { createS3Client, createPresignedGetUrl } from "@tiwi/storage";
import { runFileEnrichment, type F1LookupStore } from "@tiwi/enrichment";
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

// ---------------------------------------------------------------------------
// PDF extraction prompt (used for both single-shot and chunked paths)
// ---------------------------------------------------------------------------
const EXTRACTION_PROMPT =
  "Extract all content from this document. " +
  "For tables, output them as GitHub-flavored markdown tables — preserve all column headers, " +
  "rows, and cell values exactly as they appear. " +
  "For regular text and headings, output verbatim. " +
  "Return only the extracted content — no commentary, no JSON wrapper. " +
  "If the document is primarily visual with minimal text, describe what is visible.";

// ---------------------------------------------------------------------------
// PDF chunking
// ---------------------------------------------------------------------------
const PAGES_PER_CHUNK = 15;

async function splitPdfIntoChunks(
  buf: Buffer,
  pageSize: number,
): Promise<{ chunks: Buffer[]; totalPages: number }> {
  const src = await PDFDocument.load(buf);
  const total = src.getPageCount();
  const chunks: Buffer[] = [];
  for (let s = 0; s < total; s += pageSize) {
    const end = Math.min(s + pageSize, total);
    const doc = await PDFDocument.create();
    const pages = await doc.copyPages(
      src,
      Array.from({ length: end - s }, (_, i) => s + i),
    );
    pages.forEach((p) => doc.addPage(p));
    chunks.push(Buffer.from(await doc.save()));
  }
  return { chunks, totalPages: total };
}

function chunkText(
  text: string,
  opts: { size: number; overlap: number },
): string[] {
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

// Document files processed via GPT-5 Responses API (supports binary file upload)
const DOCUMENT_FILE_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.ms-powerpoint", // .ppt
];

// Image files processed via GPT-5 Chat Completions with image_url
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
  return (
    IMAGE_FILE_TYPES.includes(contentType) || contentType.startsWith("image/")
  );
}

function isVideoFile(contentType: string): boolean {
  return (
    VIDEO_FILE_TYPES.includes(contentType) || contentType.startsWith("video/")
  );
}

function isAudioFile(contentType: string): boolean {
  return (
    AUDIO_FILE_TYPES.includes(contentType) || contentType.startsWith("audio/")
  );
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
function log(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Record<string, unknown>,
) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    fileId: meta?.fileId,
    ...meta,
  });
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

/** Logs a heartbeat every `intervalMs` while `fn` is running. Clears itself when done. */
async function withHeartbeat<T>(
  label: string,
  meta: Record<string, unknown>,
  fn: () => Promise<T>,
  intervalMs = 30_000,
): Promise<T> {
  const start = Date.now();
  const timer = setInterval(() => {
    log("INFO", `${label} — still waiting`, {
      ...meta,
      elapsedMs: Date.now() - start,
    });
  }, intervalMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

export async function processFileV1(
  payload: ProcessFileV1Payload,
): Promise<void> {
  const env = getDaemonEnv();
  const db = await getMongoDb();

  const fileRepo = new FileRepository(db);
  const logRepo = new LogRepository(db);
  const artifactRepo = new ArtifactRepository(db);
  const embeddingRepo = new EmbeddingRepository(db);
  const f1Repo = new F1Repository(db);

  const file = await fileRepo.getFile({
    orgId: payload.orgId,
    fileId: payload.fileId,
  });
  if (!file) {
    log("WARN", "File not found, aborting", { fileId: payload.fileId });
    return;
  }

  log("INFO", "Downloading file from S3", {
    fileId: file.fileId,
    contentType: file.contentType,
    objectKey: file.objectKey,
  });
  const { client: s3, bucket } = createS3Client();
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: file.objectKey }),
  );
  const body = await streamToBuffer(obj.Body);
  log("INFO", "File downloaded", {
    fileId: file.fileId,
    sizeBytes: body.length,
  });

  let extractedText = "";
  let summary = "";

  // -------------------------------------------------------------------------
  // Stage 1 — Extract text / transcript from the source file
  // -------------------------------------------------------------------------

  if (
    (isVideoFile(file.contentType) || isAudioFile(file.contentType)) &&
    env.ASSEMBLYAI_API_KEY
  ) {
    // --- Audio / Video: AssemblyAI transcription ---
    const assemblyai = new AssemblyAI({ apiKey: env.ASSEMBLYAI_API_KEY });

    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
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
          summaryParts.push(
            `**[${m}:${s.toString().padStart(2, "0")}] ${chapter.headline}**`,
          );
          if (chapter.summary) summaryParts.push(chapter.summary);
          summaryParts.push("");
        }
      }
      summary =
        summaryParts.join("\n").trim() ||
        "Transcription complete. No chapters detected.";

      const speakerCount = transcript.utterances
        ? new Set(transcript.utterances.map((u) => u.speaker)).size
        : 0;
      const durationHours = (transcript.audio_duration ?? 0) / 3600;

      await logRepo.appendProcessingLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        level: "INFO",
        message: "AssemblyAI transcription complete",
        metadata: {
          textLength: extractedText.length,
          speakerCount,
          chapterCount: transcript.chapters?.length ?? 0,
          durationSeconds: transcript.audio_duration ?? 0,
        },
      });

      await logRepo.appendAIExecutionLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        model: "assemblyai-best",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: Number((durationHours * 0.37).toFixed(4)),
        purpose: "transcription:video",
        metadata: { durationSeconds: transcript.audio_duration, speakerCount },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logRepo.appendProcessingLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        level: "WARN",
        message: `AssemblyAI transcription failed: ${msg}`,
        metadata: { error: msg },
      });
      extractedText = "";
      summary = `Video/audio transcription failed: ${msg}`;
    }
  } else if (
    (isVideoFile(file.contentType) || isAudioFile(file.contentType)) &&
    !env.ASSEMBLYAI_API_KEY
  ) {
    extractedText = "";
    summary =
      "Video/audio file detected but ASSEMBLYAI_API_KEY is not configured.";
    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "WARN",
      message: "ASSEMBLYAI_API_KEY not set; skipping video/audio transcription",
      metadata: { contentType: file.contentType },
    });
  } else if (isDocumentFile(file.contentType) && env.OPENAI_API_KEY) {
    // --- Documents (PDF, DOCX, PPT): two focused GPT calls ---
    // Timeout set at client level — more reliable than per-request options on `as any` calls
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 600_000 });

    // Attempt to split PDFs into chunks (≤15 pages each) to avoid Responses API timeouts
    let pdfChunks: Buffer[] | null = null;
    let totalPages = 0;
    if (file.contentType === "application/pdf") {
      try {
        const split = await splitPdfIntoChunks(body, PAGES_PER_CHUNK);
        totalPages = split.totalPages;
        if (split.totalPages > PAGES_PER_CHUNK) {
          pdfChunks = split.chunks;
          log("INFO", "Large PDF — processing in chunks", {
            fileId: file.fileId,
            totalPages,
            chunks: split.chunks.length,
          });
        }
      } catch {
        // Encrypted / corrupted PDF — fall through to single-shot
      }
    }

    // Step 1: Extract raw text (GPT-5, focused — no summarization)
    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "INFO",
      message: "Step 1/2 — Extracting text from document (GPT-5)",
      metadata: {
        contentType: file.contentType,
        sizeBytes: body.length,
        chunked: pdfChunks !== null,
      },
    });

    if (pdfChunks !== null) {
      // --- Chunked path: one API call per chunk ---
      const textParts: string[] = [];
      for (let i = 0; i < pdfChunks.length; i++) {
        const chunk = pdfChunks[i]!;
        const startPage = i * PAGES_PER_CHUNK + 1;
        const endPage = Math.min((i + 1) * PAGES_PER_CHUNK, totalPages);
        const chunkDataUrl = `data:application/pdf;base64,${chunk.toString("base64")}`;
        const chunkPrompt = `Pages ${startPage}–${endPage} of ${totalPages}. ${EXTRACTION_PROMPT}`;

        try {
          log(
            "INFO",
            `GPT-5 chunk ${i + 1}/${pdfChunks.length}: extracting pages ${startPage}–${endPage}`,
            { fileId: file.fileId },
          );
          const chunkResponse: any = await withHeartbeat(
            `GPT-5 chunk ${i + 1}/${pdfChunks.length}`,
            { fileId: file.fileId },
            () =>
              (openai as any).responses.create({
                model: "gpt-5",
                max_output_tokens: 8000,
                input: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "input_file",
                        filename: `${file.originalName}-chunk${i + 1}.pdf`,
                        file_data: chunkDataUrl,
                      },
                      { type: "input_text", text: chunkPrompt },
                    ],
                  },
                ],
              }),
          );

          const chunkText = (chunkResponse.output_text ?? "").trim();
          textParts.push(chunkText);
          log("INFO", `GPT-5 chunk ${i + 1}/${pdfChunks.length}: done`, {
            fileId: file.fileId,
            extractedLength: chunkText.length,
          });

          const inTok = chunkResponse.usage?.input_tokens ?? 0;
          const outTok = chunkResponse.usage?.output_tokens ?? 0;
          await logRepo.appendAIExecutionLog({
            orgId: payload.orgId,
            fileId: payload.fileId,
            logId: nanoid(),
            model: "gpt-5",
            inputTokens: inTok,
            outputTokens: outTok,
            totalTokens: inTok + outTok,
            costUsd: estimateCostUsd({
              inputTokens: inTok,
              outputTokens: outTok,
              priceInputPer1M: GPT4O_PRICE.input,
              priceOutputPer1M: GPT4O_PRICE.output,
            }),
            purpose: "extraction:document:chunk",
            metadata: {
              contentType: file.contentType,
              chunk: i + 1,
              totalChunks: pdfChunks.length,
              startPage,
              endPage,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("WARN", `GPT-5 chunk ${i + 1}/${pdfChunks.length}: failed`, {
            fileId: file.fileId,
            error: msg,
          });
          await logRepo.appendProcessingLog({
            orgId: payload.orgId,
            fileId: payload.fileId,
            logId: nanoid(),
            level: "WARN",
            message: `Document chunk ${i + 1}/${pdfChunks.length} extraction failed: ${msg}`,
            metadata: { error: msg, chunk: i + 1 },
          });
        }
      }
      extractedText = textParts.filter(Boolean).join("\n\n");
      log("INFO", "GPT-5: chunked document text extraction complete", {
        fileId: file.fileId,
        extractedLength: extractedText.length,
        chunks: pdfChunks.length,
      });
    } else {
      // --- Single-shot path (≤15 pages or non-PDF) ---
      const base64Content = body.toString("base64");
      const dataUrl = `data:${file.contentType};base64,${base64Content}`;

      try {
        log("INFO", "GPT-5: starting document text extraction", {
          fileId: file.fileId,
          sizeBytes: body.length,
        });
        const extractionResponse: any = await withHeartbeat(
          "GPT-5 document extraction",
          { fileId: file.fileId },
          () =>
            (openai as any).responses.create({
              model: "gpt-5",
              max_output_tokens: 8000,
              input: [
                {
                  role: "user",
                  content: [
                    {
                      type: "input_file",
                      filename: file.originalName,
                      file_data: dataUrl,
                    },
                    { type: "input_text", text: EXTRACTION_PROMPT },
                  ],
                },
              ],
            }),
        );

        extractedText = (extractionResponse.output_text ?? "").trim();
        log("INFO", "GPT-5: document text extraction complete", {
          fileId: file.fileId,
          extractedLength: extractedText.length,
          inputTokens: extractionResponse.usage?.input_tokens,
          outputTokens: extractionResponse.usage?.output_tokens,
        });

        const inTok = extractionResponse.usage?.input_tokens ?? 0;
        const outTok = extractionResponse.usage?.output_tokens ?? 0;
        await logRepo.appendAIExecutionLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          model: "gpt-5",
          inputTokens: inTok,
          outputTokens: outTok,
          totalTokens: inTok + outTok,
          costUsd: estimateCostUsd({
            inputTokens: inTok,
            outputTokens: outTok,
            priceInputPer1M: GPT4O_PRICE.input,
            priceOutputPer1M: GPT4O_PRICE.output,
          }),
          purpose: "extraction:document",
          metadata: {
            contentType: file.contentType,
            extractedLength: extractedText.length,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("WARN", "GPT-5: document text extraction failed", {
          fileId: file.fileId,
          error: msg,
        });
        await logRepo.appendProcessingLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          level: "WARN",
          message: `Document text extraction failed: ${msg}`,
          metadata: { error: msg },
        });
        extractedText = "";
      }
    }

    // Step 2: Summarize
    // If we got substantial text → gpt-5-mini (cheap text summarization)
    // If text is thin (image-heavy doc) → gpt-5 Responses API (visual summary)
    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "INFO",
      message: `Step 2/2 — Summarizing document (${extractedText.length > 300 ? "gpt-5-mini on text" : "gpt-5 visual"})`,
      metadata: { extractedTextLength: extractedText.length },
    });

    if (extractedText.length > 300) {
      // Text-based summary — gpt-5-mini
      try {
        const summaryResponse = await openai.chat.completions.create({
          model: "gpt-5-mini",
          max_tokens: 600,
          messages: [
            {
              role: "system",
              content:
                "You are a document summarization assistant. Summarize the provided text in 2-3 clear paragraphs covering the key information.",
            },
            { role: "user", content: extractedText.slice(0, 30_000) },
          ],
        });
        summary =
          summaryResponse.choices[0]?.message?.content ??
          "No summary generated.";
        const inTok = summaryResponse.usage?.prompt_tokens ?? 0;
        const outTok = summaryResponse.usage?.completion_tokens ?? 0;
        await logRepo.appendAIExecutionLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          model: "gpt-5-mini",
          inputTokens: inTok,
          outputTokens: outTok,
          totalTokens: inTok + outTok,
          costUsd: estimateCostUsd({
            inputTokens: inTok,
            outputTokens: outTok,
            priceInputPer1M: GPT4O_MINI_PRICE.input,
            priceOutputPer1M: GPT4O_MINI_PRICE.output,
          }),
          purpose: "summarization:document",
          metadata: { contentType: file.contentType },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary =
          extractedText.slice(0, 800) + (extractedText.length > 800 ? "…" : "");
        await logRepo.appendProcessingLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          level: "WARN",
          message: `Document summarization failed: ${msg}`,
        });
      }
    } else {
      // Visual summary via GPT-5 Responses API (image-heavy / design doc)
      // Use first chunk (or full body for non-chunked) to avoid re-timing-out on a 50+ page PDF
      const visualSourceBuf = pdfChunks?.[0] ?? body;
      const visualDataUrl = `data:${file.contentType};base64,${visualSourceBuf.toString("base64")}`;
      try {
        const visualSummaryResponse: any = await withHeartbeat(
          "GPT-5 visual summary",
          { fileId: file.fileId },
          () =>
            (openai as any).responses.create({
              model: "gpt-5",
              max_output_tokens: 600,
              input: [
                {
                  role: "user",
                  content: [
                    {
                      type: "input_file",
                      filename: file.originalName,
                      file_data: visualDataUrl,
                    },
                    {
                      type: "input_text",
                      text: "Describe the content of this document in 2-3 paragraphs. Focus on key information, themes, people, organizations, data, and any notable elements you can observe.",
                    },
                  ],
                },
              ],
            }),
        );
        summary =
          (visualSummaryResponse.output_text ?? "").trim() ||
          "No summary generated.";
        const inTok = visualSummaryResponse.usage?.input_tokens ?? 0;
        const outTok = visualSummaryResponse.usage?.output_tokens ?? 0;
        await logRepo.appendAIExecutionLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          model: "gpt-5",
          inputTokens: inTok,
          outputTokens: outTok,
          totalTokens: inTok + outTok,
          costUsd: estimateCostUsd({
            inputTokens: inTok,
            outputTokens: outTok,
            priceInputPer1M: GPT4O_PRICE.input,
            priceOutputPer1M: GPT4O_PRICE.output,
          }),
          purpose: "summarization:document:visual",
          metadata: { contentType: file.contentType },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary = "Document is primarily visual. No text summary available.";
        await logRepo.appendProcessingLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          level: "WARN",
          message: `Visual document summarization failed: ${msg}`,
        });
      }
    }

    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "INFO",
      message: "Document processing complete",
      metadata: {
        extractedLength: extractedText.length,
        summaryLength: summary.length,
      },
    });
  } else if (isImageFile(file.contentType) && env.OPENAI_API_KEY) {
    // --- Images: two focused GPT calls ---
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const base64Content = body.toString("base64");
    const dataUrl = `data:${file.contentType};base64,${base64Content}`;

    // Step 1: Extract visible text from the image (GPT-5)
    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "INFO",
      message: "Step 1/2 — Extracting text from image (GPT-5)",
      metadata: { contentType: file.contentType, sizeBytes: body.length },
    });

    try {
      const extractionResponse = await openai.chat.completions.create({
        model: "gpt-5",
        max_tokens: 4000,
        response_format: { type: "text" },
        messages: [
          {
            role: "system",
            content:
              "Extract all visible text from the provided image verbatim. Return only the raw text — no commentary, no formatting.",
          },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataUrl } },
              {
                type: "text",
                text: "Extract all visible text from this image.",
              },
            ],
          },
        ],
      });
      extractedText = (
        extractionResponse.choices[0]?.message?.content ?? ""
      ).trim();
      const inTok = extractionResponse.usage?.prompt_tokens ?? 0;
      const outTok = extractionResponse.usage?.completion_tokens ?? 0;
      await logRepo.appendAIExecutionLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        model: "gpt-5",
        inputTokens: inTok,
        outputTokens: outTok,
        totalTokens: inTok + outTok,
        costUsd: estimateCostUsd({
          inputTokens: inTok,
          outputTokens: outTok,
          priceInputPer1M: GPT4O_PRICE.input,
          priceOutputPer1M: GPT4O_PRICE.output,
        }),
        purpose: "extraction:image",
        metadata: {
          contentType: file.contentType,
          extractedLength: extractedText.length,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logRepo.appendProcessingLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        level: "WARN",
        message: `Image text extraction failed: ${msg}`,
      });
      extractedText = "";
    }

    // Step 2: Summarize with gpt-5-mini
    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "INFO",
      message: "Step 2/2 — Summarizing image content (gpt-5-mini)",
    });

    const imageTextForSummary =
      extractedText.length > 50
        ? extractedText
        : "An image with minimal or no text content.";

    try {
      const summaryResponse = await openai.chat.completions.create({
        model: "gpt-5-mini",
        max_tokens: 600,
        messages: [
          {
            role: "system",
            content:
              "Summarize the following content extracted from an image in 1-2 paragraphs.",
          },
          { role: "user", content: imageTextForSummary.slice(0, 10_000) },
        ],
      });
      summary =
        summaryResponse.choices[0]?.message?.content ?? "No summary generated.";
      const inTok = summaryResponse.usage?.prompt_tokens ?? 0;
      const outTok = summaryResponse.usage?.completion_tokens ?? 0;
      await logRepo.appendAIExecutionLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        model: "gpt-5-mini",
        inputTokens: inTok,
        outputTokens: outTok,
        totalTokens: inTok + outTok,
        costUsd: estimateCostUsd({
          inputTokens: inTok,
          outputTokens: outTok,
          priceInputPer1M: GPT4O_MINI_PRICE.input,
          priceOutputPer1M: GPT4O_MINI_PRICE.output,
        }),
        purpose: "summarization:image",
        metadata: { contentType: file.contentType },
      });
    } catch (err) {
      summary =
        extractedText.slice(0, 500) || "Image content could not be summarized.";
    }

    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "INFO",
      message: "Image processing complete",
      metadata: {
        extractedLength: extractedText.length,
        summaryLength: summary.length,
      },
    });
  } else if (isTextBasedFile(file.contentType)) {
    // --- Plain text: read buffer, summarize with gpt-5-mini ---
    extractedText = body.toString("utf8").trim();

    if (env.OPENAI_API_KEY && extractedText.length > 0) {
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      try {
        const summaryResponse = await openai.chat.completions.create({
          model: env.OPENAI_SUMMARIZATION_MODEL,
          max_tokens: 600,
          messages: [
            {
              role: "system",
              content:
                "You are a document summarization assistant. Create a clear, comprehensive 2-3 paragraph summary of the provided text.",
            },
            { role: "user", content: extractedText.slice(0, 30_000) },
          ],
        });
        summary =
          summaryResponse.choices[0]?.message?.content ??
          "No summary generated.";
        const inTok = summaryResponse.usage?.prompt_tokens ?? 0;
        const outTok = summaryResponse.usage?.completion_tokens ?? 0;
        await logRepo.appendAIExecutionLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          model: env.OPENAI_SUMMARIZATION_MODEL,
          inputTokens: inTok,
          outputTokens: outTok,
          totalTokens: inTok + outTok,
          costUsd: estimateCostUsd({
            inputTokens: inTok,
            outputTokens: outTok,
            priceInputPer1M: env.OPENAI_PRICE_INPUT_PER_1M_USD,
            priceOutputPer1M: env.OPENAI_PRICE_OUTPUT_PER_1M_USD,
          }),
          purpose: "summarization:text",
        });
      } catch (err) {
        summary =
          extractedText.slice(0, 800) + (extractedText.length > 800 ? "…" : "");
      }
    } else {
      summary =
        extractedText.length === 0
          ? "No extractable text found."
          : extractedText.slice(0, 800) +
            (extractedText.length > 800 ? "…" : "");
    }

    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "INFO",
      message: "Text extraction complete",
      metadata: { bytes: body.length, contentType: file.contentType },
    });
  } else {
    // --- Unsupported ---
    extractedText = "";
    summary = `Unsupported file type: ${file.contentType}. Unable to extract text.`;
    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "WARN",
      message: `Unsupported file type for text extraction: ${file.contentType}`,
      metadata: { contentType: file.contentType },
    });
  }

  // -------------------------------------------------------------------------
  // Stage 2 — Persist summary + generate embeddings
  // -------------------------------------------------------------------------

  // For image-heavy documents, use summary as enrichment text when extracted text is thin
  const textForEnrichment =
    extractedText.trim().length > 100 ? extractedText.trim() : summary;

  log("INFO", "Stage 2: persisting summary and generating embeddings", {
    fileId: file.fileId,
    extractedLength: extractedText.length,
    summaryLength: summary.length,
    enrichmentSource:
      extractedText.trim().length > 100 ? "extractedText" : "summary",
  });
  await artifactRepo.setFileSummary({
    orgId: payload.orgId,
    fileId: payload.fileId,
    summary,
  });

  if (env.OPENAI_API_KEY) {
    await embeddingRepo.deleteChunksForFile({
      orgId: payload.orgId,
      fileId: payload.fileId,
    });

    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const chunks = chunkText(textForEnrichment.slice(0, 100_000), {
      size: 1200,
      overlap: 200,
    });

    for (let idx = 0; idx < chunks.length; idx++) {
      const text = chunks[idx]!;
      const embedding = await openai.embeddings.create({
        model: env.OPENAI_EMBEDDING_MODEL,
        input: text,
      });
      const vector = embedding.data[0]?.embedding ?? [];
      const promptTokens = (embedding as any).usage?.prompt_tokens ?? 0;
      const totalTokens =
        (embedding as any).usage?.total_tokens ?? promptTokens;

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
      metadata: {
        chunks: chunks.length,
        source: extractedText.trim().length > 100 ? "extractedText" : "summary",
      },
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

  // -------------------------------------------------------------------------
  // Stage 3 — F1 entity enrichment (LangGraph)
  // -------------------------------------------------------------------------

  const enrichmentText = textForEnrichment.slice(0, 25_000);

  log("INFO", "Stage 3: starting F1 enrichment", {
    fileId: file.fileId,
    textLength: enrichmentText.length,
  });

  await logRepo.appendProcessingLog({
    orgId: payload.orgId,
    fileId: payload.fileId,
    logId: nanoid(),
    level: "INFO",
    message: "Starting F1 entity enrichment",
    metadata: { textLength: enrichmentText.length },
  });

  // F1 lookup store backed by the F1Repository — resolves FKs to existing
  // reference entities persisted by previous files.
  const lookupStore: F1LookupStore = {
    lookupDriver: async (name) => {
      const hit = await f1Repo.findDriverByNameOrAlias({
        orgId: payload.orgId,
        name,
      });
      return hit ? { entityId: hit.entityId, name: hit.name } : null;
    },
    lookupConstructor: async (name) => {
      const hit = await f1Repo.findConstructorByNameOrAlias({
        orgId: payload.orgId,
        name,
      });
      return hit ? { entityId: hit.entityId, name: hit.name } : null;
    },
    lookupCircuit: async (name) => {
      const hit = await f1Repo.findCircuitByNameOrAlias({
        orgId: payload.orgId,
        name,
      });
      return hit ? { entityId: hit.entityId, name: hit.name } : null;
    },
    lookupSeason: async (year) => {
      const hit = await f1Repo.findSeasonByYear({ orgId: payload.orgId, year });
      return hit ? { entityId: hit.entityId, name: hit.name } : null;
    },
    lookupGrandPrix: async (name) => {
      const hit = await f1Repo.findGrandPrixByNameOrAlias({
        orgId: payload.orgId,
        name,
      });
      return hit ? { entityId: hit.entityId, name: hit.name } : null;
    },
  };

  // Embedding chunks for provenance fallback when extractors don't provide one.
  const sourceChunkIds = Array.from(
    { length: Math.max(1, Math.ceil(enrichmentText.length / 1200)) },
    (_, i) => `${payload.fileId}:${i}`,
  );

  const enrichment = await runFileEnrichment({
    orgId: payload.orgId,
    fileId: payload.fileId,
    text: enrichmentText,
    sourceChunkIds,
    lookupStore,
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
    if (d.level === "WARN") {
      log("WARN", `[enrichment] ${d.message}`, {
        fileId: file.fileId,
        ...(d.metadata ?? {}),
      });
    }
  }

  // Surface any hard errors from the enrichment graph directly to daemon stdout
  // so they are visible without tailing the processing_logs collection.
  for (const errMsg of enrichment.errors) {
    log("ERROR", `[enrichment] ${errMsg}`, { fileId: file.fileId });
    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "ERROR",
      message: `Enrichment error: ${errMsg}`,
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

  // -------------------------------------------------------------------------
  // Persist F1 drafts in dependency order.
  //
  // Reference entities are upserted first. Because the repo may return an
  // existing canonical entityId (e.g. "Max" already exists for Verstappen),
  // we track a draft-entityId → canonical-entityId map and remap every
  // downstream FK before persisting facts.
  // -------------------------------------------------------------------------

  const idMap = new Map<string, string>();
  const remap = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : (idMap.get(id) ?? id);

  // Tier 1 — drivers
  for (const d of enrichment.drivers) {
    const canonical = await f1Repo.upsertDriver({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      name: d.name,
      aliases: d.aliases,
      entityId: d.entityId,
      extra: {
        nationality: d.nationality,
        number: d.number,
        dateOfBirth: d.dateOfBirth,
      },
    });
    idMap.set(d.entityId, canonical);
  }

  // Tier 1 — constructors
  for (const c of enrichment.constructors) {
    const canonical = await f1Repo.upsertConstructor({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      name: c.name,
      aliases: c.aliases,
      entityId: c.entityId,
      extra: { base: c.base, powerUnit: c.powerUnit },
    });
    idMap.set(c.entityId, canonical);
  }

  // Tier 1 — circuits
  for (const c of enrichment.circuits) {
    const canonical = await f1Repo.upsertCircuit({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      name: c.name,
      aliases: c.aliases,
      entityId: c.entityId,
      extra: {
        country: c.country,
        city: c.city,
        lapLengthKm: c.lapLengthKm,
        numberOfLaps: c.numberOfLaps,
      },
    });
    idMap.set(c.entityId, canonical);
  }

  // Tier 1 — seasons
  for (const s of enrichment.seasons) {
    const canonical = await f1Repo.upsertSeason({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      name: s.name,
      aliases: s.aliases,
      entityId: s.entityId,
      extra: {
        year: s.year,
        driverChampionId: remap(s.driverChampionId),
        constructorChampionId: remap(s.constructorChampionId),
      },
    });
    idMap.set(s.entityId, canonical);
  }

  // Tier 1 — team principals (FK → constructor)
  for (const tp of enrichment.teamPrincipals) {
    const canonical = await f1Repo.upsertTeamPrincipal({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      name: tp.name,
      aliases: tp.aliases,
      entityId: tp.entityId,
      extra: {
        constructorId: remap(tp.constructorId),
        startDate: tp.startDate,
        endDate: tp.endDate,
      },
    });
    idMap.set(tp.entityId, canonical);
  }

  // Tier 1 — grand prix (FK → season, circuit)
  for (const gp of enrichment.grandsPrix) {
    const canonical = await f1Repo.upsertGrandPrix({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      name: gp.name,
      aliases: gp.aliases,
      entityId: gp.entityId,
      extra: {
        seasonId: remap(gp.seasonId),
        circuitId: remap(gp.circuitId),
        date: gp.date,
        round: gp.round,
        isSprintWeekend: gp.isSprintWeekend,
      },
    });
    idMap.set(gp.entityId, canonical);
  }

  // Tier 1 — driver seats (FK → driver, constructor, season)
  for (const seat of enrichment.driverSeats) {
    const driverId = remap(seat.driverId);
    const constructorId = remap(seat.constructorId);
    if (!driverId || !constructorId) continue;
    const canonical = await f1Repo.upsertDriverSeat({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      entityId: seat.entityId,
      driverId,
      constructorId,
      seasonId: remap(seat.seasonId),
      startDate: seat.startDate,
      endDate: seat.endDate,
      isReserveOrTest: seat.isReserveOrTest,
      name: seat.name,
    });
    idMap.set(seat.entityId, canonical);
  }

  // Helper: pull the first provenance entry from a fact draft, or skip if missing.
  const firstProv = <T extends { provenance?: readonly unknown[] }>(
    d: T,
  ): import("@tiwi/mongodb").FactProvenance | null => {
    const arr = (d.provenance ??
      []) as import("@tiwi/mongodb").FactProvenance[];
    return arr[0] ?? null;
  };

  // Tier 2 — race results
  for (const r of enrichment.raceResults) {
    const provenance = firstProv(r);
    if (!provenance) continue;
    await f1Repo.upsertRaceResult({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      provenance,
      entityId: r.entityId,
      doc: {
        name: r.name,
        driverId: remap(r.driverId),
        constructorId: remap(r.constructorId),
        grandPrixId: remap(r.grandPrixId),
        seasonId: remap(r.seasonId),
        position: r.position,
        points: r.points,
        gridPosition: r.gridPosition,
        laps: r.laps,
        status: r.status,
        raceTimeMs: r.raceTimeMs,
        gapToWinnerMs: r.gapToWinnerMs,
        fastestLapTimeMs: r.fastestLapTimeMs,
        hadFastestLap: r.hadFastestLap,
      },
    });
  }

  // Tier 2 — qualifying results
  for (const q of enrichment.qualifyingResults) {
    const provenance = firstProv(q);
    if (!provenance) continue;
    await f1Repo.upsertQualifyingResult({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      provenance,
      entityId: q.entityId,
      doc: {
        name: q.name,
        driverId: remap(q.driverId),
        constructorId: remap(q.constructorId),
        grandPrixId: remap(q.grandPrixId),
        seasonId: remap(q.seasonId),
        gridPosition: q.gridPosition,
        q1Ms: q.q1Ms,
        q2Ms: q.q2Ms,
        q3Ms: q.q3Ms,
        knockedOutIn: q.knockedOutIn,
      },
    });
  }

  // Tier 2 — sprint results
  for (const s of enrichment.sprintResults) {
    const provenance = firstProv(s);
    if (!provenance) continue;
    await f1Repo.upsertSprintResult({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      provenance,
      entityId: s.entityId,
      doc: {
        name: s.name,
        driverId: remap(s.driverId),
        constructorId: remap(s.constructorId),
        grandPrixId: remap(s.grandPrixId),
        seasonId: remap(s.seasonId),
        position: s.position,
        points: s.points,
        gridPosition: s.gridPosition,
        status: s.status,
      },
    });
  }

  // Tier 2 — pit stops
  for (const p of enrichment.pitStops) {
    const provenance = firstProv(p);
    if (!provenance) continue;
    await f1Repo.upsertPitStop({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      provenance,
      entityId: p.entityId,
      doc: {
        name: p.name,
        driverId: remap(p.driverId),
        constructorId: remap(p.constructorId),
        grandPrixId: remap(p.grandPrixId),
        seasonId: remap(p.seasonId),
        stopNumber: p.stopNumber,
        lap: p.lap,
        durationMs: p.durationMs,
        tyreCompoundFrom: p.tyreCompoundFrom,
        tyreCompoundTo: p.tyreCompoundTo,
      },
    });
  }

  // Tier 3 — incidents
  for (const inc of enrichment.incidents) {
    const provenance = firstProv(inc);
    if (!provenance) continue;
    await f1Repo.upsertIncident({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      provenance,
      entityId: inc.entityId,
      doc: {
        name: inc.name,
        driverIds: inc.driverIds?.map((id) => remap(id) ?? id),
        grandPrixId: remap(inc.grandPrixId),
        seasonId: remap(inc.seasonId),
        lap: inc.lap,
        incidentType: inc.incidentType,
        description: inc.description,
        causedSafetyCar: inc.causedSafetyCar,
        causedVirtualSafetyCar: inc.causedVirtualSafetyCar,
        causedRedFlag: inc.causedRedFlag,
      },
    });
  }

  // Tier 3 — penalties
  for (const pen of enrichment.penalties) {
    const provenance = firstProv(pen);
    if (!provenance) continue;
    await f1Repo.upsertPenalty({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      provenance,
      entityId: pen.entityId,
      doc: {
        name: pen.name,
        recipientId: remap(pen.recipientId),
        recipientType: pen.recipientType,
        grandPrixId: remap(pen.grandPrixId),
        seasonId: remap(pen.seasonId),
        penaltyType: pen.penaltyType,
        value: pen.value,
        unit: pen.unit,
        reason: pen.reason,
        relatedIncidentId: remap(pen.relatedIncidentId),
      },
    });
  }

  // Tier 4 — cars
  for (const car of enrichment.cars) {
    const provenance = firstProv(car);
    if (!provenance) continue;
    await f1Repo.upsertCar({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      provenance,
      entityId: car.entityId,
      doc: {
        name: car.name,
        constructorId: remap(car.constructorId),
        seasonId: remap(car.seasonId),
        designation: car.designation,
      },
    });
  }

  // Tier 4 — tyre compounds
  for (const tc of enrichment.tyreCompounds) {
    const provenance = firstProv(tc);
    if (!provenance) continue;
    await f1Repo.upsertTyreCompound({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      provenance,
      entityId: tc.entityId,
      doc: {
        name: tc.name,
        compound: tc.compound,
        supplier: tc.supplier,
      },
    });
  }

  // Tier 4 — quotes
  for (const q of enrichment.quotes) {
    const provenance = firstProv(q);
    if (!provenance) continue;
    await f1Repo.upsertQuote({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      provenance,
      entityId: q.entityId,
      doc: {
        name: q.name,
        speakerId: remap(q.speakerId),
        speakerType: q.speakerType,
        grandPrixId: remap(q.grandPrixId),
        context: q.context,
        text: q.text,
      },
    });
  }

  // Tier 4 — transfer rumours
  for (const tr of enrichment.transferRumours) {
    const provenance = firstProv(tr);
    if (!provenance) continue;
    await f1Repo.upsertTransferRumour({
      orgId: payload.orgId,
      sourceFileId: payload.fileId,
      provenance,
      entityId: tr.entityId,
      doc: {
        name: tr.name,
        driverId: remap(tr.driverId),
        fromConstructorId: remap(tr.fromConstructorId),
        toConstructorId: remap(tr.toConstructorId),
        targetSeasonId: remap(tr.targetSeasonId),
        reportedDate: tr.reportedDate,
        reportedStatus: tr.reportedStatus,
      },
    });
  }

  const totals = {
    drivers: enrichment.drivers.length,
    constructors: enrichment.constructors.length,
    teamPrincipals: enrichment.teamPrincipals.length,
    circuits: enrichment.circuits.length,
    seasons: enrichment.seasons.length,
    grandsPrix: enrichment.grandsPrix.length,
    driverSeats: enrichment.driverSeats.length,
    raceResults: enrichment.raceResults.length,
    qualifyingResults: enrichment.qualifyingResults.length,
    sprintResults: enrichment.sprintResults.length,
    pitStops: enrichment.pitStops.length,
    incidents: enrichment.incidents.length,
    penalties: enrichment.penalties.length,
    cars: enrichment.cars.length,
    tyreCompounds: enrichment.tyreCompounds.length,
    quotes: enrichment.quotes.length,
    transferRumours: enrichment.transferRumours.length,
    errors: enrichment.errors.length,
  };

  log("INFO", "Processing pipeline complete", {
    fileId: file.fileId,
    ...totals,
  });

  await logRepo.appendProcessingLog({
    orgId: payload.orgId,
    fileId: payload.fileId,
    logId: nanoid(),
    level: "INFO",
    message: "Processing pipeline complete",
    metadata: totals,
  });
}
