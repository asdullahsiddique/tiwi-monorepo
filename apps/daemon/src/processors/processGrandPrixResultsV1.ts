import { GetObjectCommand } from "@aws-sdk/client-s3";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { nanoid } from "nanoid";
import { z } from "zod";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FileRepository,
  getMongoDb,
  GpResultRepository,
  LogRepository,
} from "@tiwi/mongodb";
import { createS3Client } from "@tiwi/storage";
import { estimateAnthropicCostUsd } from "../anthropicPricing";
import type { ProcessFileV1Payload } from "../jobs/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DAEMON_ROOT = path.resolve(__dirname, "../..");

const GpResultsEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_AGENT_MODEL: z.string().min(1).default("claude-opus-4-7"),
  CLAUDE_AGENT_MAX_TURNS: z.coerce.number().int().positive().default(200),
  ANTHROPIC_CLAUDE_OPUS_INPUT_USD_PER_1M: z.coerce.number().nonnegative().default(15),
  ANTHROPIC_CLAUDE_OPUS_OUTPUT_USD_PER_1M: z.coerce.number().nonnegative().default(75),
  ANTHROPIC_CLAUDE_SONNET_INPUT_USD_PER_1M: z.coerce.number().nonnegative().default(3),
  ANTHROPIC_CLAUDE_SONNET_OUTPUT_USD_PER_1M: z.coerce.number().nonnegative().default(15),
});

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
  polePosition: PoleOrFastestLapSchema.optional(),
  fastestLap: PoleOrFastestLapSchema.optional(),
  results: z.array(ResultEntrySchema),
});

const RaceSchema = z.object({
  raceNumber: z.number().int().min(1),
  polePosition: PoleOrFastestLapSchema.optional(),
  fastestLap: PoleOrFastestLapSchema.optional(),
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

function agentLog(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    scope: "gp_results_agent",
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

function getMessageUsage(message: SDKMessage): {
  inputTokens: number;
  outputTokens: number;
} {
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

function formatToolCallMessage(
  toolCalls: Array<{ name: string; inputSummary: string }>,
): string {
  if (toolCalls.length === 1) {
    const [toolCall] = toolCalls;
    return `Claude agent tool call: ${toolCall.name} — ${toolCall.inputSummary}`;
  }
  return `Claude agent tool calls: ${toolCalls
    .map((toolCall) => `${toolCall.name} — ${toolCall.inputSummary}`)
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
        metadata: {
          type: message.type,
          textPreview,
          toolCalls,
        },
      };
    }
    if (textPreview) {
      return {
        level: "INFO",
        message: textPreview.slice(0, 500),
        metadata: { type: message.type },
      };
    }
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
    const toolCalls = getToolCalls(content);
    const textPreview = getAssistantTextPreview(content);

    agentLog("INFO", "Claude agent assistant message", {
      ...base,
      toolCalls,
      textPreview,
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

  agentLog("INFO", "Claude agent SDK event", {
    ...base,
    subtype: (message as any).subtype,
  });
}

async function copyIfExists(source: string, target: string): Promise<void> {
  try {
    await cp(source, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

export async function processGrandPrixResultsV1(
  payload: ProcessFileV1Payload,
): Promise<void> {
  const env = GpResultsEnvSchema.parse(process.env);

  const db = await getMongoDb();
  const fileRepo = new FileRepository(db);
  const logRepo = new LogRepository(db);
  const gpResultRepo = new GpResultRepository(db);

  const file = await fileRepo.getFile({
    orgId: payload.orgId,
    fileId: payload.fileId,
  });
  if (!file) {
    throw new Error(`File not found: ${payload.fileId}`);
  }
  if (file.contentType !== "application/pdf") {
    throw new Error(
      `Grand Prix agent extraction supports PDFs only, got ${file.contentType}`,
    );
  }

  await logRepo.appendProcessingLog({
    orgId: payload.orgId,
    fileId: payload.fileId,
    logId: nanoid(),
    level: "INFO",
    message: "Starting Grand Prix results extraction with Claude agent",
    metadata: {
      contentType: file.contentType,
      model: env.CLAUDE_AGENT_MODEL,
      documentType: payload.documentType,
      maxTurns: env.CLAUDE_AGENT_MAX_TURNS,
    },
  });

  const { client: s3, bucket } = createS3Client();
  agentLog("INFO", "Downloading GP result PDF from object storage", {
    orgId: payload.orgId,
    fileId: payload.fileId,
    objectKey: file.objectKey,
    bucket,
  });
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: file.objectKey }),
  );
  const body = await streamToBuffer(obj.Body);
  agentLog("INFO", "Downloaded GP result PDF", {
    orgId: payload.orgId,
    fileId: payload.fileId,
    bytes: body.byteLength,
  });

  const workDir = await mkdtemp(
    path.join(os.tmpdir(), `tiwi-gp-${payload.fileId}-`),
  );

  let inputTokens = 0;
  let outputTokens = 0;

  try {
    await writeFile(path.join(workDir, "source.pdf"), body);
    await cp(path.join(DAEMON_ROOT, "SKILL.md"), path.join(workDir, "SKILL.md"));
    await copyIfExists(
      path.join(DAEMON_ROOT, "schema.md"),
      path.join(workDir, "schema.md"),
    );
    agentLog("INFO", "Prepared Claude agent working directory", {
      orgId: payload.orgId,
      fileId: payload.fileId,
      workDir,
      sourcePdf: path.join(workDir, "source.pdf"),
      skill: path.join(workDir, "SKILL.md"),
    });

    const prompt =
      "Follow ./SKILL.md exactly. The source PDF is ./source.pdf. When finished, write ./rounds.json containing a JSON array of RoundResult objects. Do not stop until ./rounds.json exists and validates as JSON.";

    agentLog("INFO", "Starting Claude agent extraction loop", {
      orgId: payload.orgId,
      fileId: payload.fileId,
      model: env.CLAUDE_AGENT_MODEL,
      maxTurns: env.CLAUDE_AGENT_MAX_TURNS,
      allowedTools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "Task"],
    });

    for await (const message of query({
      prompt,
      options: {
        cwd: workDir,
        model: env.CLAUDE_AGENT_MODEL,
        maxTurns: env.CLAUDE_AGENT_MAX_TURNS,
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "Task"],
      },
    })) {
      const usage = getMessageUsage(message);
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      logAgentMessageToStdout({
        orgId: payload.orgId,
        fileId: payload.fileId,
        message,
        usage,
        accumulatedUsage: { inputTokens, outputTokens },
      });

      const summary = summarizeAgentMessage(message);
      if (summary) {
        await logRepo.appendProcessingLog({
          orgId: payload.orgId,
          fileId: payload.fileId,
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
    }

    const raw = JSON.parse(
      await readFile(path.join(workDir, "rounds.json"), "utf8"),
    );
    const rounds = RoundsJsonSchema.parse(raw) as RoundResult[];
    agentLog("INFO", "Validated agent rounds.json", {
      orgId: payload.orgId,
      fileId: payload.fileId,
      rounds: rounds.length,
      roundsPath: path.join(workDir, "rounds.json"),
    });

    await gpResultRepo.replaceRoundsForFile({
      orgId: payload.orgId,
      fileId: payload.fileId,
      rounds,
    });
    agentLog("INFO", "Persisted GP result rounds", {
      orgId: payload.orgId,
      fileId: payload.fileId,
      rounds: rounds.length,
    });

    const costUsd = estimateAnthropicCostUsd({
      model: env.CLAUDE_AGENT_MODEL,
      inputTokens,
      outputTokens,
      env,
    });

    await logRepo.appendAIExecutionLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      model: env.CLAUDE_AGENT_MODEL,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd,
      purpose: "gp_results:agent",
      metadata: {
        rounds: rounds.length,
        workDirCleaned: true,
      },
    });

    await logRepo.appendProcessingLog({
      orgId: payload.orgId,
      fileId: payload.fileId,
      logId: nanoid(),
      level: "INFO",
      message: `Grand Prix results extraction complete: ${rounds.length} round(s)`,
      metadata: {
        rounds: rounds.map((round) => ({
          type: round.type,
          championship:
            round.type === "multi-class" ? round.championship : undefined,
          grandPrix: round.grandPrix,
          round: round.type === "multi-class" ? round.round : undefined,
        })),
      },
    });
  } finally {
    agentLog("INFO", "Cleaning up Claude agent working directory", {
      orgId: payload.orgId,
      fileId: payload.fileId,
      workDir,
    });
    await rm(workDir, { recursive: true, force: true });
  }
}
