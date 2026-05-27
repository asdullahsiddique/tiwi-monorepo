import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { AssemblyAI } from "assemblyai";
import { nanoid } from "nanoid";
import { z } from "zod";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ArtifactRepository,
  FileRepository,
  F1Repository,
  getMongoDb,
  GpResultRepository,
  LogRepository,
} from "@tiwi/mongodb";
import { createPresignedGetUrl, createS3Client } from "@tiwi/storage";
import { runFileEnrichment, type F1LookupStore } from "@tiwi/enrichment";
import { estimateAnthropicCostUsd } from "../anthropicPricing";
import { getDaemonEnv } from "../env";
import type { ProcessFileV1Payload } from "../jobs/types";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DAEMON_ROOT = path.resolve(__dirname, "../..");

const nullableOptionalString = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);
const nullableOptionalNumber = z
  .number()
  .nullish()
  .transform((value) => value ?? undefined);
const nullableOptionalPosition = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((value) => value ?? undefined);

const PoleOrFastestLapSchema = z.object({
  driver: nullableOptionalString,
  team: nullableOptionalString,
  time: nullableOptionalString,
});
const nullableOptionalPoleOrFastestLap = PoleOrFastestLapSchema.nullish().transform(
  (value) => value ?? undefined,
);

const ResultEntrySchema = z.object({
  position: nullableOptionalPosition,
  driver: z.string().min(1),
  team: nullableOptionalString,
  car: nullableOptionalString,
  timeOrGap: nullableOptionalString,
  points: nullableOptionalNumber,
});

const GpSingleRaceResultSchema = z.object({
  type: z.literal("single"),
  grandPrix: z.string().min(1),
  circuit: z.string().min(1),
  country: nullableOptionalString,
  dateStart: nullableOptionalString,
  dateEnd: nullableOptionalString,
  polePosition: nullableOptionalPoleOrFastestLap,
  fastestLap: nullableOptionalPoleOrFastestLap,
  results: z.array(ResultEntrySchema),
});

const RaceSchema = z.object({
  raceNumber: z.number().int().min(1),
  polePosition: nullableOptionalPoleOrFastestLap,
  fastestLap: nullableOptionalPoleOrFastestLap,
  results: z.array(ResultEntrySchema),
});

const CategorySchema = z.object({
  name: z.enum([
    "TROFEO PIRELLI",
    "TROFEO PIRELLI AM",
    "COPPA SHELL",
    "COPPA SHELL AM",
    "TROFEO PIRELLI MID",
  ]),
  races: z.array(RaceSchema),
});

const MultiClassRoundResultSchema = z.object({
  type: z.literal("multi-class"),
  championship: z.string().min(1),
  grandPrix: z.string().min(1),
  circuit: z.string().min(1),
  country: nullableOptionalString,
  dateStart: nullableOptionalString,
  dateEnd: nullableOptionalString,
  round: nullableOptionalNumber,
  totalRounds: nullableOptionalNumber,
  categories: z.array(CategorySchema),
});

const RoundResultSchema = z.discriminatedUnion("type", [
  GpSingleRaceResultSchema,
  MultiClassRoundResultSchema,
]);
const RoundsJsonSchema = z.array(RoundResultSchema);
type RoundResult = z.infer<typeof RoundResultSchema>;

const DOCUMENT_FILE_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
];
const IMAGE_FILE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
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

function isConvertibleOfficeFile(contentType: string): boolean {
  return isDocumentFile(contentType) && contentType !== "application/pdf";
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

function extensionForContentType(contentType: string, originalName: string): string {
  const ext = path.extname(originalName).replace(/^\./, "").toLowerCase();
  if (ext) return ext;
  if (contentType === "application/pdf") return "pdf";
  if (contentType.includes("wordprocessingml")) return "docx";
  if (contentType === "application/msword") return "doc";
  if (contentType.includes("presentationml")) return "pptx";
  if (contentType === "application/vnd.ms-powerpoint") return "ppt";
  if (contentType === "image/jpeg" || contentType === "image/jpg") return "jpg";
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/gif") return "gif";
  return "bin";
}

function buildCheckpointPrefix(params: { orgId: string; fileId: string }): string {
  return ["org", params.orgId, "file-processing-checkpoints", params.fileId, "unified"].join("/");
}

function buildCheckpointKey(params: { orgId: string; fileId: string; fileName: string }): string {
  return [buildCheckpointPrefix(params), params.fileName].join("/");
}

function agentLog(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    scope: "unified_document_agent",
    ...meta,
  });
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

function log(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Record<string, unknown>,
): void {
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

async function streamToBuffer(stream: any): Promise<Buffer> {
  if (Buffer.isBuffer(stream)) return stream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function getMessageUsage(message: SDKMessage): { inputTokens: number; outputTokens: number } {
  if (message.type !== "result") {
    const usage = "usage" in message ? (message.usage as any) : undefined;
    return {
      inputTokens: usage?.input_tokens ?? usage?.inputTokens ?? 0,
      outputTokens: usage?.output_tokens ?? usage?.outputTokens ?? 0,
    };
  }
  const usage = message.usage as any;
  return {
    inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
    outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
  };
}

function truncateText(value: string, max = 1_000): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function stringifyParam(value: unknown, max = 1_000): string {
  if (typeof value === "string") return truncateText(value, max);
  try {
    return truncateText(JSON.stringify(value), max);
  } catch {
    return truncateText(String(value), max);
  }
}

function getAssistantTextPreview(content: any[]): string | undefined {
  const text = content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking ?? block.text;
      return "";
    })
    .join("")
    .trim();
  return text ? truncateText(text, 1_000) : undefined;
}

function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return stringifyParam(input.command ?? input.cmd ?? input);
    case "Read":
      return stringifyParam(input.file_path ?? input.path ?? input);
    case "Write":
    case "Edit":
      return stringifyParam(input.file_path ?? input.path ?? input);
    case "Glob":
      return stringifyParam(input.pattern ?? input.glob_pattern ?? input);
    case "Grep":
      return stringifyParam(input.pattern ?? input);
    case "Task":
      return stringifyParam(input.description ?? input.prompt ?? input);
    default:
      return stringifyParam(input);
  }
}

function getToolCalls(content: any[]): Array<{
  id?: string;
  name: string;
  input: Record<string, unknown>;
  inputSummary: string;
}> {
  return content
    .filter((block) => block.type === "tool_use" && typeof block.name === "string")
    .map((block) => {
      const input =
        block.input && typeof block.input === "object"
          ? (block.input as Record<string, unknown>)
          : {};
      return {
        id: block.id,
        name: block.name,
        input,
        inputSummary: summarizeToolInput(block.name, input),
      };
    });
}

function formatToolCallMessage(toolCalls: Array<{ name: string; inputSummary: string }>): string {
  if (toolCalls.length === 1) {
    const [toolCall] = toolCalls;
    return `Claude agent tool call: ${toolCall.name} - ${toolCall.inputSummary}`;
  }
  return `Claude agent tool calls: ${toolCalls
    .map((toolCall) => `${toolCall.name} - ${toolCall.inputSummary}`)
    .join("; ")}`;
}

function summarizeAgentMessage(message: SDKMessage): {
  level: "INFO" | "WARN" | "ERROR";
  message: string;
  metadata?: Record<string, unknown>;
} | null {
  if (message.type === "assistant") {
    const content = (message.message.content ?? []) as any[];
    const textPreview = getAssistantTextPreview(content);
    const toolCalls = getToolCalls(content);
    if (toolCalls.length > 0) {
      return {
        level: "INFO",
        message: formatToolCallMessage(toolCalls),
        metadata: { type: message.type, textPreview, toolCalls },
      };
    }
    if (textPreview) return { level: "INFO", message: textPreview.slice(0, 500), metadata: { type: message.type } };
    return null;
  }
  if (message.type === "result") {
    return {
      level: message.subtype === "success" ? "INFO" : "ERROR",
      message:
        message.subtype === "success"
          ? "Claude agent extraction loop completed"
          : `Claude agent extraction loop failed: ${message.subtype}`,
      metadata: {
        type: message.type,
        subtype: message.subtype,
        numTurns: message.num_turns,
        stopReason: message.stop_reason,
        errors: "errors" in message ? message.errors : undefined,
      },
    };
  }
  if (message.type === "system") {
    const subtype = (message as any).subtype;
    if (subtype === "api_retry") {
      return {
        level: "WARN",
        message: "Claude agent API retry",
        metadata: {
          subtype,
          attempt: (message as any).attempt,
          maxRetries: (message as any).max_retries,
          retryDelayMs: (message as any).retry_delay_ms,
        },
      };
    }
    if (subtype === "task_notification") {
      return {
        level: "INFO",
        message: `Claude agent task ${(message as any).status ?? "updated"}`,
        metadata: message as unknown as Record<string, unknown>,
      };
    }
  }
  return null;
}

function logAgentMessageToStdout(params: {
  orgId: string;
  fileId: string;
  message: SDKMessage;
  usage: { inputTokens: number; outputTokens: number };
  accumulatedUsage: { inputTokens: number; outputTokens: number };
}): void {
  const { message, usage, accumulatedUsage } = params;
  const base = {
    orgId: params.orgId,
    fileId: params.fileId,
    sdkMessageType: message.type,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalInputTokens: accumulatedUsage.inputTokens,
    totalOutputTokens: accumulatedUsage.outputTokens,
  };
  if (message.type === "assistant") {
    const content = (message.message.content ?? []) as any[];
    agentLog("INFO", "Claude agent assistant message", {
      ...base,
      toolCalls: getToolCalls(content),
      textPreview: getAssistantTextPreview(content),
    });
    return;
  }
  if (message.type === "result") {
    agentLog(message.subtype === "success" ? "INFO" : "ERROR", "Claude agent result", {
      ...base,
      subtype: message.subtype,
      numTurns: message.num_turns,
      stopReason: message.stop_reason,
      totalCostUsd: message.total_cost_usd,
      errors: "errors" in message ? message.errors : undefined,
    });
    return;
  }
  if (message.type === "system") {
    agentLog("INFO", "Claude agent system event", {
      ...base,
      subtype: (message as any).subtype,
      status: (message as any).status,
      summary: (message as any).summary,
      outputFile: (message as any).output_file,
    });
    return;
  }
  agentLog("INFO", "Claude agent SDK event", { ...base, subtype: (message as any).subtype });
}

async function copyIfExists(source: string, target: string): Promise<void> {
  try {
    await cp(source, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function getCheckpointText(params: {
  s3: ReturnType<typeof createS3Client>["client"];
  bucket: string;
  checkpointKey: string;
}): Promise<string | null> {
  try {
    const checkpoint = await params.s3.send(
      new GetObjectCommand({ Bucket: params.bucket, Key: params.checkpointKey }),
    );
    const body = await streamToBuffer(checkpoint.Body);
    return body.toString("utf8");
  } catch (err) {
    const code = (err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code;
    if (code === "NoSuchKey" || code === "NotFound") return null;
    throw err;
  }
}

async function putCheckpointText(params: {
  s3: ReturnType<typeof createS3Client>["client"];
  bucket: string;
  checkpointKey: string;
  text: string;
  contentType: string;
}): Promise<void> {
  await params.s3.send(
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.checkpointKey,
      Body: params.text,
      ContentType: params.contentType,
    }),
  );
}

async function convertOfficeToPdf(params: {
  workDir: string;
  sourcePath: string;
  originalName: string;
}): Promise<string> {
  await execFileAsync("libreoffice", [
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    params.workDir,
    params.sourcePath,
  ]);
  const baseName = path.basename(params.sourcePath, path.extname(params.sourcePath));
  return path.join(params.workDir, `${baseName}.pdf`);
}

async function summarizeWithClaude(params: {
  anthropic: Anthropic;
  model: string;
  orgId: string;
  fileId: string;
  text: string;
  logRepo: LogRepository;
  env: ReturnType<typeof getDaemonEnv>;
}): Promise<string> {
  const source = params.text.trim();
  if (!source) return "No extractable text found.";
  try {
    const response = await params.anthropic.messages.create({
      model: params.model,
      max_tokens: 700,
      messages: [
        {
          role: "user",
          content:
            "Summarize the following extracted file content in 2-3 clear paragraphs. Focus on key facts, people, organizations, events, and useful search context.\n\n" +
            source.slice(0, 30_000),
        },
      ],
    } as any);
    const summary = (response.content ?? [])
      .map((block: any) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim() || "No summary generated.";
    const inputTokens = (response.usage as any)?.input_tokens ?? 0;
    const outputTokens = (response.usage as any)?.output_tokens ?? 0;
    await params.logRepo.appendAIExecutionLog({
      orgId: params.orgId,
      fileId: params.fileId,
      logId: nanoid(),
      model: params.model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd: estimateAnthropicCostUsd({
        model: params.model,
        inputTokens,
        outputTokens,
        env: params.env,
      }),
      purpose: "summarization:claude",
      metadata: { textLength: source.length },
    });
    return summary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await params.logRepo.appendProcessingLog({
      orgId: params.orgId,
      fileId: params.fileId,
      logId: nanoid(),
      level: "WARN",
      message: `Claude summarization failed: ${msg}`,
      metadata: { error: msg },
    });
    return source.slice(0, 800) + (source.length > 800 ? "..." : "");
  }
}

async function transcribeMedia(params: {
  payload: ProcessFileV1Payload;
  file: { contentType: string; objectKey: string };
  bodyLength: number;
  logRepo: LogRepository;
  assemblyAiApiKey?: string;
}): Promise<{ extractedText: string; summary: string }> {
  if (!params.assemblyAiApiKey) {
    await params.logRepo.appendProcessingLog({
      orgId: params.payload.orgId,
      fileId: params.payload.fileId,
      logId: nanoid(),
      level: "WARN",
      message: "ASSEMBLYAI_API_KEY not set; skipping video/audio transcription",
      metadata: { contentType: params.file.contentType },
    });
    return {
      extractedText: "",
      summary: "Video/audio file detected but ASSEMBLYAI_API_KEY is not configured.",
    };
  }

  const assemblyai = new AssemblyAI({ apiKey: params.assemblyAiApiKey });
  await params.logRepo.appendProcessingLog({
    orgId: params.payload.orgId,
    fileId: params.payload.fileId,
    logId: nanoid(),
    level: "INFO",
    message: "Starting video/audio transcription with AssemblyAI",
    metadata: { contentType: params.file.contentType, sizeBytes: params.bodyLength },
  });

  const presignedUrl = await createPresignedGetUrl({
    objectKey: params.file.objectKey,
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

    const extractedText = transcript.text ?? "";
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
    const summary = summaryParts.join("\n").trim() || "Transcription complete. No chapters detected.";
    const speakerCount = transcript.utterances
      ? new Set(transcript.utterances.map((u) => u.speaker)).size
      : 0;
    const durationHours = (transcript.audio_duration ?? 0) / 3600;

    await params.logRepo.appendProcessingLog({
      orgId: params.payload.orgId,
      fileId: params.payload.fileId,
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
    await params.logRepo.appendAIExecutionLog({
      orgId: params.payload.orgId,
      fileId: params.payload.fileId,
      logId: nanoid(),
      model: "assemblyai-best",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: Number((durationHours * 0.37).toFixed(4)),
      purpose: "transcription:video",
      metadata: { durationSeconds: transcript.audio_duration, speakerCount },
    });
    return { extractedText, summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await params.logRepo.appendProcessingLog({
      orgId: params.payload.orgId,
      fileId: params.payload.fileId,
      logId: nanoid(),
      level: "WARN",
      message: `AssemblyAI transcription failed: ${msg}`,
      metadata: { error: msg },
    });
    return { extractedText: "", summary: `Video/audio transcription failed: ${msg}` };
  }
}

async function runDocumentAgent(params: {
  payload: ProcessFileV1Payload;
  body: Buffer;
  contentType: string;
  originalName: string;
  objectKey: string;
  s3: ReturnType<typeof createS3Client>["client"];
  bucket: string;
  logRepo: LogRepository;
  gpResultRepo: GpResultRepository;
  env: ReturnType<typeof getDaemonEnv>;
}): Promise<{
  rounds: RoundResult[];
  text: string;
  inputTokens: number;
  outputTokens: number;
  sdkReportedCostUsd?: number;
}> {
  const roundsKey = buildCheckpointKey({ orgId: params.payload.orgId, fileId: params.payload.fileId, fileName: "rounds.json" });
  const textKey = buildCheckpointKey({ orgId: params.payload.orgId, fileId: params.payload.fileId, fileName: "text.md" });
  const [roundsCheckpoint, textCheckpoint] = await Promise.all([
    getCheckpointText({ s3: params.s3, bucket: params.bucket, checkpointKey: roundsKey }),
    getCheckpointText({ s3: params.s3, bucket: params.bucket, checkpointKey: textKey }),
  ]);

  if (roundsCheckpoint !== null && textCheckpoint !== null) {
    await params.logRepo.appendProcessingLog({
      orgId: params.payload.orgId,
      fileId: params.payload.fileId,
      logId: nanoid(),
      level: "INFO",
      message: "Found saved unified extraction checkpoint; validating before rerunning agent",
      metadata: { roundsKey, textKey },
    });
    try {
      const rounds = RoundsJsonSchema.parse(JSON.parse(roundsCheckpoint)) as RoundResult[];
      await params.gpResultRepo.replaceRoundsForFile({
        orgId: params.payload.orgId,
        fileId: params.payload.fileId,
        rounds,
      });
      return { rounds, text: textCheckpoint, inputTokens: 0, outputTokens: 0 };
    } catch (err) {
      await params.logRepo.appendProcessingLog({
        orgId: params.payload.orgId,
        fileId: params.payload.fileId,
        logId: nanoid(),
        level: "WARN",
        message: "Saved unified extraction checkpoint did not validate; rerunning agent",
        metadata: { error: err instanceof Error ? err.message : String(err), roundsKey, textKey },
      });
    }
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), `tiwi-doc-${params.payload.fileId}-`));
  let inputTokens = 0;
  let outputTokens = 0;
  let sdkReportedCostUsd: number | undefined;

  try {
    const ext = extensionForContentType(params.contentType, params.originalName);
    const rawSourcePath = path.join(workDir, `source.${ext}`);
    await writeFile(rawSourcePath, params.body);

    let agentSourcePath = rawSourcePath;
    if (isConvertibleOfficeFile(params.contentType)) {
      await params.logRepo.appendProcessingLog({
        orgId: params.payload.orgId,
        fileId: params.payload.fileId,
        logId: nanoid(),
        level: "INFO",
        message: "Converting document to PDF with LibreOffice",
        metadata: { contentType: params.contentType, originalName: params.originalName },
      });
      agentSourcePath = await convertOfficeToPdf({
        workDir,
        sourcePath: rawSourcePath,
        originalName: params.originalName,
      });
    } else if (params.contentType === "application/pdf") {
      await cp(rawSourcePath, path.join(workDir, "source.pdf"));
    }

    await cp(path.join(DAEMON_ROOT, "SKILL.md"), path.join(workDir, "SKILL.md"));
    await copyIfExists(path.join(DAEMON_ROOT, "schema.md"), path.join(workDir, "schema.md"));

    agentLog("INFO", "Prepared Claude agent working directory", {
      orgId: params.payload.orgId,
      fileId: params.payload.fileId,
      workDir,
      sourcePath: agentSourcePath,
    });

    const prompt =
      "Follow ./SKILL.md exactly. The source file is ./source.*. When finished, write ./rounds.json containing a JSON array of RoundResult objects and ./text.md containing extracted narrative markdown. Do not stop until both files exist and rounds.json validates as JSON.";

    for await (const message of query({
      prompt,
      options: {
        cwd: workDir,
        model: params.env.CLAUDE_AGENT_MODEL,
        maxTurns: params.env.CLAUDE_AGENT_MAX_TURNS,
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "Task"],
      },
    })) {
      const usage = getMessageUsage(message);
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      logAgentMessageToStdout({
        orgId: params.payload.orgId,
        fileId: params.payload.fileId,
        message,
        usage,
        accumulatedUsage: { inputTokens, outputTokens },
      });
      const summary = summarizeAgentMessage(message);
      if (summary) {
        await params.logRepo.appendProcessingLog({
          orgId: params.payload.orgId,
          fileId: params.payload.fileId,
          logId: nanoid(),
          level: summary.level,
          message: summary.message,
          metadata: summary.metadata,
        });
      }
      if (message.type === "result" && message.subtype !== "success") {
        const errors =
          "errors" in message && message.errors.length > 0
            ? message.errors.join("; ")
            : message.subtype;
        throw new Error(`Claude agent failed: ${errors}`);
      }
      if (message.type === "result" && message.subtype === "success") {
        sdkReportedCostUsd =
          typeof message.total_cost_usd === "number"
            ? message.total_cost_usd
            : sdkReportedCostUsd;
      }
    }

    const roundsText = await readFile(path.join(workDir, "rounds.json"), "utf8");
    const text = await readFile(path.join(workDir, "text.md"), "utf8");
    await Promise.all([
      putCheckpointText({ s3: params.s3, bucket: params.bucket, checkpointKey: roundsKey, text: roundsText, contentType: "application/json" }),
      putCheckpointText({ s3: params.s3, bucket: params.bucket, checkpointKey: textKey, text, contentType: "text/markdown" }),
    ]);

    const rounds = RoundsJsonSchema.parse(JSON.parse(roundsText)) as RoundResult[];
    await params.gpResultRepo.replaceRoundsForFile({
      orgId: params.payload.orgId,
      fileId: params.payload.fileId,
      rounds,
    });
    return { rounds, text, inputTokens, outputTokens, sdkReportedCostUsd };
  } finally {
    agentLog("INFO", "Cleaning up Claude agent working directory", {
      orgId: params.payload.orgId,
      fileId: params.payload.fileId,
      workDir,
    });
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function processFileV2(payload: ProcessFileV1Payload): Promise<void> {
  const env = getDaemonEnv();

  const db = await getMongoDb();
  const fileRepo = new FileRepository(db);
  const logRepo = new LogRepository(db);
  const artifactRepo = new ArtifactRepository(db);
  const f1Repo = new F1Repository(db);
  const gpResultRepo = new GpResultRepository(db);

  const file = await fileRepo.getFile({ orgId: payload.orgId, fileId: payload.fileId });
  if (!file) {
    agentLog("WARN", "File not found, aborting", { fileId: payload.fileId });
    return;
  }

  const { client: s3, bucket } = createS3Client();
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: file.objectKey }));
  const body = await streamToBuffer(obj.Body);

  await logRepo.appendProcessingLog({
    orgId: payload.orgId,
    fileId: payload.fileId,
    logId: nanoid(),
    level: "INFO",
    message: "Starting unified Claude document processing",
    metadata: {
      contentType: file.contentType,
      sizeBytes: body.length,
      documentType: payload.documentType,
      model: env.CLAUDE_AGENT_MODEL,
    },
  });

  let extractedText = "";
  let summary = "";
  let agentRounds: RoundResult[] = [];
  let agentInputTokens = 0;
  let agentOutputTokens = 0;

  if (isDocumentFile(file.contentType) || isImageFile(file.contentType)) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is required for document/image extraction");
    }
    const result = await runDocumentAgent({
      payload,
      body,
      contentType: file.contentType,
      originalName: file.originalName,
      objectKey: file.objectKey,
      s3,
      bucket,
      logRepo,
      gpResultRepo,
      env,
    });
    extractedText = result.text.trim();
    agentRounds = result.rounds;
    agentInputTokens = result.inputTokens;
    agentOutputTokens = result.outputTokens;
    if (agentInputTokens + agentOutputTokens > 0) {
      await logRepo.appendAIExecutionLog({
        orgId: payload.orgId,
        fileId: payload.fileId,
        logId: nanoid(),
        model: env.CLAUDE_AGENT_MODEL,
        inputTokens: agentInputTokens,
        outputTokens: agentOutputTokens,
        totalTokens: agentInputTokens + agentOutputTokens,
        costUsd:
          result.sdkReportedCostUsd ??
          estimateAnthropicCostUsd({
            model: env.CLAUDE_AGENT_MODEL,
            inputTokens: agentInputTokens,
            outputTokens: agentOutputTokens,
            env,
          }),
        purpose: "document_extraction:agent",
        metadata: {
          rounds: agentRounds.length,
          textLength: extractedText.length,
          sdkReportedCostUsd: result.sdkReportedCostUsd,
        },
      });
    }
  } else if (isVideoFile(file.contentType) || isAudioFile(file.contentType)) {
    const media = await transcribeMedia({
      payload,
      file,
      bodyLength: body.length,
      logRepo,
      assemblyAiApiKey: env.ASSEMBLYAI_API_KEY,
    });
    extractedText = media.extractedText;
    summary = media.summary;
    await gpResultRepo.replaceRoundsForFile({ orgId: payload.orgId, fileId: payload.fileId, rounds: [] });
  } else if (isTextBasedFile(file.contentType)) {
    extractedText = body.toString("utf8").trim();
    await gpResultRepo.replaceRoundsForFile({ orgId: payload.orgId, fileId: payload.fileId, rounds: [] });
  } else {
    extractedText = "";
    summary = `Unsupported file type: ${file.contentType}. Unable to extract text.`;
    await gpResultRepo.replaceRoundsForFile({ orgId: payload.orgId, fileId: payload.fileId, rounds: [] });
    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "WARN",
      message: `Unsupported file type for text extraction: ${file.contentType}`,
      metadata: { contentType: file.contentType },
    });
  }

  if (!summary) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is required for Claude summarization");
    }
    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    summary = await summarizeWithClaude({
      anthropic,
      model: env.CLAUDE_SUMMARY_MODEL,
      orgId: payload.orgId,
      fileId: payload.fileId,
      text: extractedText,
      logRepo,
      env,
    });
  }

  await artifactRepo.setFileExtractedText({
    orgId: payload.orgId,
    fileId: payload.fileId,
    text: extractedText,
  });
  await artifactRepo.setFileSummary({
    orgId: payload.orgId,
    fileId: payload.fileId,
    summary,
  });

  const textForEnrichment = extractedText.trim().length > 100 ? extractedText.trim() : summary;
  // -------------------------------------------------------------------------
  // Stage 3 - F1 entity enrichment (LangGraph)
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

  // F1 lookup store backed by the F1Repository - resolves FKs to existing
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

  // Tier 1 - drivers
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

  // Tier 1 - constructors
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

  // Tier 1 - circuits
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

  // Tier 1 - seasons
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

  // Tier 1 - team principals (FK → constructor)
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

  // Tier 1 - grand prix (FK → season, circuit)
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

  // Tier 1 - driver seats (FK → driver, constructor, season)
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

  // Tier 2 - race results
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

  // Tier 2 - qualifying results
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

  // Tier 2 - sprint results
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

  // Tier 2 - pit stops
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

  // Tier 3 - incidents
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

  // Tier 3 - penalties
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

  // Tier 4 - cars
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

  // Tier 4 - tyre compounds
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

  // Tier 4 - quotes
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

  // Tier 4 - transfer rumours
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
