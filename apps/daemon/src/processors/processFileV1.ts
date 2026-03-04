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
  seedEntityTypes,
} from "@tiwi/neo4j";
import { createS3Client, createPresignedGetUrl } from "@tiwi/storage";
import { runFileEnrichment } from "@tiwi/enrichment";
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

// File types that GPT-4o can process directly via file upload
const GPT_SUPPORTED_FILE_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
];

function isGptSupportedFile(contentType: string): boolean {
  return GPT_SUPPORTED_FILE_TYPES.includes(contentType);
}

function isTextBasedFile(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/xml" ||
    contentType === "application/javascript"
  );
}

// Video file types supported via AssemblyAI transcription
const VIDEO_FILE_TYPES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/mpeg",
  "video/ogg",
];

// Audio file types also supported via AssemblyAI
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

function isVideoFile(contentType: string): boolean {
  return VIDEO_FILE_TYPES.includes(contentType) || contentType.startsWith("video/");
}

function isAudioFile(contentType: string): boolean {
  return AUDIO_FILE_TYPES.includes(contentType) || contentType.startsWith("audio/");
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
    const entityRepo = new EntityRepository(driver);

    // Ensure built-in entity types are seeded
    await seedEntityTypes({ typeRegistryRepo: typeRepo, orgId: payload.orgId });

    const file = await fileRepo.getFile({ orgId: payload.orgId, fileId: payload.fileId });
    if (!file) {
      // Nothing to do; file record missing.
      return;
    }

    const { client: s3, bucket } = createS3Client();
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: file.objectKey }));
    const body = await streamToBuffer(obj.Body);

    let extractedText = "";
    let summary = "";

    // Use AssemblyAI for video and audio files
    if ((isVideoFile(file.contentType) || isAudioFile(file.contentType)) && env.ASSEMBLYAI_API_KEY) {
      const assemblyai = new AssemblyAI({ apiKey: env.ASSEMBLYAI_API_KEY });

      await logRepo.appendProcessingLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        level: "INFO",
        message: "Starting video/audio transcription with AssemblyAI",
        metadata: { contentType: file.contentType, sizeBytes: body.length },
      });

      // Generate presigned URL for AssemblyAI to fetch the file
      // URL valid for 2 hours to allow for long transcription jobs
      const presignedUrl = await createPresignedGetUrl({
        objectKey: file.objectKey,
        expiresInSeconds: 7200,
      });

      try {
        // Submit transcription job with speaker diarization and auto chapters
        // Note: auto_chapters and summarization cannot be enabled at the same time
        const transcript = await assemblyai.transcripts.transcribe({
          audio: presignedUrl,
          speaker_labels: true,      // Identify different speakers (useful for interviews)
          auto_chapters: true,       // Break into chapters automatically (includes summaries per chapter)
        });

        if (transcript.status === "error") {
          throw new Error(`AssemblyAI transcription failed: ${transcript.error}`);
        }

        extractedText = transcript.text ?? "";
        
        // Build summary from AssemblyAI's auto chapters (each chapter has headline + summary)
        const summaryParts: string[] = [];
        
        if (transcript.chapters && transcript.chapters.length > 0) {
          for (const chapter of transcript.chapters) {
            const startTime = Math.floor((chapter.start ?? 0) / 1000);
            const minutes = Math.floor(startTime / 60);
            const seconds = startTime % 60;
            const timestamp = `${minutes}:${seconds.toString().padStart(2, "0")}`;
            summaryParts.push(`**[${timestamp}] ${chapter.headline}**`);
            if (chapter.summary) {
              summaryParts.push(chapter.summary);
            }
            summaryParts.push(""); // Empty line between chapters
          }
        }

        summary = summaryParts.join("\n").trim() || "Transcription complete. No chapters detected.";

        // Log speaker information if available
        const speakerCount = transcript.utterances 
          ? new Set(transcript.utterances.map(u => u.speaker)).size 
          : 0;

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

        // Log AI execution (AssemblyAI pricing: ~$0.37/hour for best model)
        const durationHours = (transcript.audio_duration ?? 0) / 3600;
        const estimatedCost = durationHours * 0.37; // Best model pricing

        await logRepo.appendAIExecutionLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          model: "assemblyai-best",
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: Number(estimatedCost.toFixed(4)),
          purpose: "transcription:video",
          metadata: {
            durationSeconds: transcript.audio_duration,
            speakerCount,
          },
        });
      } catch (transcriptionError) {
        const errorMessage = transcriptionError instanceof Error 
          ? transcriptionError.message 
          : String(transcriptionError);
        
        await logRepo.appendProcessingLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          level: "WARN",
          message: `AssemblyAI transcription failed: ${errorMessage}`,
          metadata: { error: errorMessage },
        });

        extractedText = "";
        summary = `Video/audio transcription failed: ${errorMessage}`;
      }
    } else if ((isVideoFile(file.contentType) || isAudioFile(file.contentType)) && !env.ASSEMBLYAI_API_KEY) {
      // Video/audio file but no AssemblyAI key
      extractedText = "";
      summary = "Video/audio file detected but ASSEMBLYAI_API_KEY is not configured. Unable to transcribe.";
      
      await logRepo.appendProcessingLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        level: "WARN",
        message: "ASSEMBLYAI_API_KEY not set; skipping video/audio transcription",
        metadata: { contentType: file.contentType },
      });
    } else if (isGptSupportedFile(file.contentType) && env.OPENAI_API_KEY) {
      // Use GPT for PDFs and images
      const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      
      // Convert file to base64
      const base64Content = body.toString("base64");
      const dataUrl = `data:${file.contentType};base64,${base64Content}`;

      await logRepo.appendProcessingLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        level: "INFO",
        message: "Sending file to GPT for extraction and summarization",
        metadata: { contentType: file.contentType, sizeBytes: body.length },
      });

      // Use the new Responses API for PDFs, Chat Completions for images
      const isPdf = file.contentType === "application/pdf";
      
      if (isPdf) {
        // Use the Responses API with input_file for PDFs
        const extractionResponse = await (openai as any).responses.create({
          model: "gpt-4o",
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_file",
                  filename: file.originalName,
                  file_data: dataUrl,
                },
                {
                  type: "input_text",
                  text: "Extract all text content from this document and create a comprehensive summary. Return JSON with two fields: 'extractedText' (the full text content from the document) and 'summary' (a 2-3 paragraph summary of the key information). Return ONLY valid JSON.",
                },
              ],
            },
          ],
        });

        const extractionContent = extractionResponse.output_text ?? "{}";
        // Try to extract JSON from the response (may be wrapped in markdown)
        let jsonContent = extractionContent;
        const jsonMatch = extractionContent.match(/```json\s*([\s\S]*?)\s*```/) || 
                          extractionContent.match(/```\s*([\s\S]*?)\s*```/) ||
                          extractionContent.match(/(\{[\s\S]*\})/);
        if (jsonMatch) {
          jsonContent = jsonMatch[1];
        }
        
        const extractionResult = JSON.parse(jsonContent) as { extractedText?: string; summary?: string };
        
        extractedText = extractionResult.extractedText ?? "";
        summary = extractionResult.summary ?? "No summary generated.";

        const inputTokens = extractionResponse.usage?.input_tokens ?? 0;
        const outputTokens = extractionResponse.usage?.output_tokens ?? 0;
        const totalTokens = inputTokens + outputTokens;

        await logRepo.appendAIExecutionLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          model: "gpt-4o",
          inputTokens,
          outputTokens,
          totalTokens,
          costUsd: estimateCostUsd({
            inputTokens,
            outputTokens,
            priceInputPer1M: 2.5,
            priceOutputPer1M: 10,
          }),
          purpose: "extraction:pdf",
          metadata: { contentType: file.contentType },
        });
      } else {
        // Use Chat Completions API with image_url for images
        const extractionResponse = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: "You are a document processing assistant. Extract all text content from the provided image and create a comprehensive summary. Return JSON with two fields: 'extractedText' (the full text content) and 'summary' (a 2-3 paragraph summary of the key information).",
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Extract all text and summarize this image. Return JSON: {\"extractedText\": \"...\", \"summary\": \"...\"}",
                },
                {
                  type: "image_url",
                  image_url: { url: dataUrl },
                },
              ],
            },
          ],
          response_format: { type: "json_object" },
          max_tokens: 16000,
        });

        const extractionContent = extractionResponse.choices[0]?.message?.content ?? "{}";
        const extractionResult = JSON.parse(extractionContent) as { extractedText?: string; summary?: string };
        
        extractedText = extractionResult.extractedText ?? "";
        summary = extractionResult.summary ?? "No summary generated.";

        const inputTokens = extractionResponse.usage?.prompt_tokens ?? 0;
        const outputTokens = extractionResponse.usage?.completion_tokens ?? 0;
        const totalTokens = extractionResponse.usage?.total_tokens ?? inputTokens + outputTokens;

        await logRepo.appendAIExecutionLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          model: "gpt-4o",
          inputTokens,
          outputTokens,
          totalTokens,
          costUsd: estimateCostUsd({
            inputTokens,
            outputTokens,
            priceInputPer1M: 2.5,
            priceOutputPer1M: 10,
          }),
          purpose: "extraction:image",
          metadata: { contentType: file.contentType },
        });
      }

      await logRepo.appendProcessingLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        level: "INFO",
        message: "GPT extraction complete",
        metadata: { extractedLength: extractedText.length, summaryLength: summary.length },
      });
    } else if (isTextBasedFile(file.contentType)) {
      // Plain text extraction for text files
      extractedText = body.toString("utf8").trim();
      
      // Generate AI summary for text files if OpenAI is configured
      if (env.OPENAI_API_KEY && extractedText.length > 0) {
        const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
        
        const summaryResponse = await openai.chat.completions.create({
          model: env.OPENAI_SUMMARIZATION_MODEL,
          messages: [
            {
              role: "system",
              content: "You are a document summarization assistant. Create a clear, comprehensive 2-3 paragraph summary of the provided text.",
            },
            {
              role: "user",
              content: `Summarize the following document:\n\n${extractedText.slice(0, 30000)}`,
            },
          ],
          max_tokens: 1000,
        });

        summary = summaryResponse.choices[0]?.message?.content ?? "No summary generated.";

        const inputTokens = summaryResponse.usage?.prompt_tokens ?? 0;
        const outputTokens = summaryResponse.usage?.completion_tokens ?? 0;
        const totalTokens = summaryResponse.usage?.total_tokens ?? inputTokens + outputTokens;

        await logRepo.appendAIExecutionLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          model: env.OPENAI_SUMMARIZATION_MODEL,
          inputTokens,
          outputTokens,
          totalTokens,
          costUsd: estimateCostUsd({
            inputTokens,
            outputTokens,
            priceInputPer1M: env.OPENAI_PRICE_INPUT_PER_1M_USD,
            priceOutputPer1M: env.OPENAI_PRICE_OUTPUT_PER_1M_USD,
          }),
          purpose: "summarization:text",
        });
      } else {
        summary = extractedText.length === 0
          ? "No extractable text found."
          : extractedText.slice(0, 800) + (extractedText.length > 800 ? "…" : "");
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
      // Unsupported file type
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

    const trimmed = extractedText.trim();
    await artifactRepo.setFileSummary({ orgId: payload.orgId, fileId: payload.fileId, summary });

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

    // Fetch existing context for entity resolution
    const existingTypes = await entityRepo.getAllEntityTypes({ orgId: payload.orgId });
    const existingEntities = await entityRepo.getEntitiesSummary({ orgId: payload.orgId, limit: 200 });

    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "INFO",
      message: "Fetched context for entity resolution",
      metadata: {
        existingTypes: existingTypes.length,
        existingEntities: existingEntities.length,
      },
    });

    // LangGraph enrichment with context (best-effort; returns empty if no key).
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
      context: {
        existingTypes: existingTypes.map((t) => ({
          typeName: t.typeName,
          description: t.description,
          entityCount: t.entityCount,
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

    // Register any new types that were created during enrichment
    for (const newType of enrichment.createdTypes) {
      try {
        await typeRepo.createType({
          orgId: payload.orgId,
          typeName: newType.typeName,
          description: newType.description,
          createdBy: payload.userId,
        });
        await logRepo.appendProcessingLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
          logId: nanoid(),
          level: "INFO",
          message: `Registered new entity type: ${newType.typeName}`,
          metadata: { description: newType.description },
        });
      } catch {
        // Type may already exist, that's fine
      }
    }

    // Persist extracted entities to Neo4j
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

    // Persist relationships to Neo4j
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
        resolvedMatches: enrichment.resolvedMatches?.length ?? 0,
      },
    });
  } finally {
    await driver.close();
  }
}

