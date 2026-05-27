import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { nanoid } from "nanoid";
import {
  appendAgentQueryEvent,
  completeAgentQuery,
  failAgentQuery,
  getMongoDb,
  LogRepository,
  type AgentQueryEvent,
  type AgentQueryEventLevel,
  type AgentQueryEventType,
  type AgentQueryJobDoc,
} from "@tiwi/mongodb";
import { estimateAnthropicCostUsd } from "../anthropicPricing";
import { getDaemonEnv } from "../env";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DAEMON_ROOT = path.resolve(__dirname, "../..");

const SYSTEM_PROMPT = [
  "You are a Ferrari motorsport research assistant.",
  "Your working directory contains a corpus of PDF press releases and almanaccos about Ferrari's racing programmes (Formula 1, FIA WEC with the 499P, GT World Challenge, Ferrari Challenge, Macau, etc.). Italian and English texts are mixed; year subfolders (e.g. ./2025/) group press releases by year, and large multi-round almanaccos sit at the root.",
  "",
  "Tools at your disposal:",
  "- Glob to discover files by name pattern (e.g. `**/*Macao*.pdf`).",
  "- Read to read PDFs and other text files. Read returns extracted text from PDFs.",
  "- Grep to search file contents.",
  "- Bash for occasional shell helpers (ls, wc, etc.) — read-only operations only, the corpus is immutable.",
  "",
  "How to answer:",
  "1. Use Glob to find relevant filenames first; pick a small set (1-6 files) before reading.",
  "2. Read each candidate file fully. Quote facts faithfully — never invent results, times, or quotes.",
  "3. If the user's question references a previous turn, use the conversation history (provided below) to resolve it before searching files.",
  "4. Reply in markdown. Be concise and factual. When you cite content from a specific file, mention its filename in italics at the end of the relevant paragraph (e.g. *source: Doppietta Ferrari nella Qualifying Race a Macao.pdf*).",
  "5. If the corpus does not contain the answer, say so plainly rather than guessing.",
].join("\n");

function buildPrompt(job: AgentQueryJobDoc): string {
  const parts: string[] = [SYSTEM_PROMPT, ""];
  if (job.history.length > 0) {
    parts.push("## Conversation so far");
    for (const turn of job.history) {
      const role = turn.role === "user" ? "User" : "Assistant";
      parts.push(`**${role}:** ${turn.content}`);
    }
    parts.push("");
  }
  parts.push("## Current user question");
  parts.push(job.prompt);
  parts.push("");
  parts.push(
    "Answer the current user question using the corpus in the working directory. Reply with markdown only — no JSON, no preamble.",
  );
  return parts.join("\n");
}

function logLine(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope: "agent_query",
    message,
    ...meta,
  });
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

function truncate(value: string, max = 200): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}…`;
}

function basenameOf(value: unknown): string {
  if (typeof value !== "string") return "a file";
  return path.basename(value);
}

type ToolCall = {
  id?: string;
  name: string;
  input: Record<string, unknown>;
};

function getToolCalls(content: unknown[]): ToolCall[] {
  return content
    .filter(
      (
        block,
      ): block is {
        type: "tool_use";
        name: string;
        id?: string;
        input?: unknown;
      } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "tool_use" &&
        typeof (block as { name?: unknown }).name === "string",
    )
    .map((block) => ({
      id: block.id,
      name: block.name,
      input:
        block.input && typeof block.input === "object"
          ? (block.input as Record<string, unknown>)
          : {},
    }));
}

function getAssistantText(content: unknown[]): string {
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const b = block as { type?: string; text?: unknown; thinking?: unknown };
      if (b.type === "text" && typeof b.text === "string") return b.text;
      return "";
    })
    .join("")
    .trim();
}

/** Friendly one-liner used by the FE activity indicator. */
function labelForToolCall(tc: ToolCall): string {
  switch (tc.name) {
    case "Glob": {
      const pattern = tc.input.pattern ?? tc.input.glob_pattern;
      return typeof pattern === "string"
        ? `Searching the archive for ${truncate(pattern, 80)}`
        : "Searching the archive...";
    }
    case "Read": {
      const filePath = tc.input.file_path ?? tc.input.path;
      const base = basenameOf(filePath);
      return base && base !== "a file" ? `Reading ${base}` : "Reading a file";
    }
    case "Grep": {
      const pattern = tc.input.pattern;
      return typeof pattern === "string"
        ? `Searching for "${truncate(pattern, 80)}"`
        : "Searching the archive...";
    }
    case "Bash":
      return "Running a quick check...";
    case "Task":
      return "Dispatching a sub-task...";
    default:
      return `Using ${tc.name}...`;
  }
}

function eventForSdkMessage(message: SDKMessage): AgentQueryEvent | null {
  const eventId = nanoid();
  const ts = new Date();

  if (message.type === "assistant") {
    const content = (message.message.content ?? []) as unknown[];
    const toolCalls = getToolCalls(content);
    if (toolCalls.length > 0) {
      const primary = toolCalls[0];
      const label = labelForToolCall(primary);
      return {
        eventId,
        ts,
        level: "INFO",
        type: "tool_call",
        message: label,
        metadata: {
          toolNames: toolCalls.map((tc) => tc.name),
          toolInputs: toolCalls.map((tc) => tc.input),
        },
      };
    }
    const text = getAssistantText(content);
    if (text.length > 0) {
      return {
        eventId,
        ts,
        level: "INFO",
        type: "assistant_text",
        message: "Drafting an answer...",
        metadata: { textPreview: truncate(text, 500) },
      };
    }
    return null;
  }

  if (message.type === "system") {
    const subtype = (message as { subtype?: string }).subtype;
    if (subtype === "api_retry") {
      return {
        eventId,
        ts,
        level: "WARN",
        type: "system",
        message: "Reconnecting to the model...",
        metadata: message as unknown as Record<string, unknown>,
      };
    }
    return null;
  }

  if (message.type === "result") {
    const isSuccess = message.subtype === "success";
    return {
      eventId,
      ts,
      level: isSuccess ? "INFO" : "ERROR",
      type: "result",
      message: isSuccess
        ? "Finalising response..."
        : `Agent failed: ${message.subtype}`,
      metadata: {
        subtype: message.subtype,
        numTurns: (message as { num_turns?: number }).num_turns,
        stopReason: (message as { stop_reason?: string }).stop_reason,
      },
    };
  }

  return null;
}

function getMessageUsage(message: SDKMessage): {
  inputTokens: number;
  outputTokens: number;
} {
  const raw = (message as { usage?: Record<string, unknown> }).usage;
  if (!raw) return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens: Number(raw.input_tokens ?? raw.inputTokens ?? 0),
    outputTokens: Number(raw.output_tokens ?? raw.outputTokens ?? 0),
  };
}

function getFinalAssistantText(message: SDKMessage): string | null {
  if (message.type !== "result") return null;
  const result = (message as { result?: unknown }).result;
  if (typeof result === "string" && result.trim().length > 0) {
    return result.trim();
  }
  return null;
}

/**
 * Resolved corpus directory for the current process. Defaults to the bundled
 * `apps/daemon/tiwi-testing` folder both in Docker (under `/app/apps/daemon`)
 * and in local dev. Override with `TIWI_CORPUS_DIR` when needed.
 */
export function resolveCorpusDir(): string {
  const env = getDaemonEnv();
  return env.TIWI_CORPUS_DIR ?? path.join(DAEMON_ROOT, "tiwi-testing");
}

export async function runAgentQuery(job: AgentQueryJobDoc): Promise<void> {
  const env = getDaemonEnv();
  const db = await getMongoDb();
  const logRepo = new LogRepository(db);

  if (!env.ANTHROPIC_API_KEY) {
    const reason = "ANTHROPIC_API_KEY is still not configured on the daemon";
    logLine("ERROR", reason, { jobId: job.jobId });
    await failAgentQuery(db, job.jobId, reason);
    return;
  }

  const corpusDir = resolveCorpusDir();
  const prompt = buildPrompt(job);

  logLine("INFO", "Starting agent query", {
    jobId: job.jobId,
    orgId: job.orgId,
    conversationId: job.conversationId,
    corpusDir,
    historyLength: job.history.length,
    promptLength: job.prompt.length,
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let sdkReportedCostUsd: number | undefined;
  let finalText = "";
  let succeeded = false;
  let failureReason: string | undefined;

  const pushEvent = async (event: AgentQueryEvent | null) => {
    if (!event) return;
    try {
      await appendAgentQueryEvent(db, job.jobId, event);
    } catch (err) {
      logLine("WARN", "Failed to append agent query event", {
        jobId: job.jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await pushEvent({
    eventId: nanoid(),
    ts: new Date(),
    level: "INFO",
    type: "system",
    message: "Searching the archive...",
  });

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: corpusDir,
        model: env.CLAUDE_AGENT_MODEL,
        maxTurns: env.AGENT_QUERY_MAX_TURNS,
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Glob", "Grep", "Bash", "Task"],
      },
    })) {
      const usage = getMessageUsage(message);
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;

      await pushEvent(eventForSdkMessage(message));

      if (message.type === "result") {
        if (message.subtype === "success") {
          succeeded = true;
          const text = getFinalAssistantText(message);
          if (text) finalText = text;
          sdkReportedCostUsd =
            typeof (message as { total_cost_usd?: number }).total_cost_usd ===
            "number"
              ? (message as { total_cost_usd?: number }).total_cost_usd
              : sdkReportedCostUsd;
        } else {
          succeeded = false;
          const errs = (message as { errors?: string[] }).errors;
          failureReason =
            errs && errs.length > 0 ? errs.join("; ") : message.subtype;
        }
      }
    }

    if (!succeeded) {
      throw new Error(
        failureReason ?? "Agent SDK did not return a successful result",
      );
    }

    if (!finalText) {
      finalText =
        "The assistant did not produce a text response. Please try rephrasing your question.";
    }

    const costUsd =
      sdkReportedCostUsd ??
      estimateAnthropicCostUsd({
        model: env.CLAUDE_AGENT_MODEL,
        inputTokens,
        outputTokens,
        env,
      });

    await completeAgentQuery(db, job.jobId, {
      responseMarkdown: finalText,
      tokensIn: inputTokens,
      tokensOut: outputTokens,
      costUsd,
    });

    await logRepo.appendAIExecutionLog({
      orgId: job.orgId,
      logId: nanoid(),
      model: env.CLAUDE_AGENT_MODEL,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd,
      purpose: "agent_query",
      metadata: {
        jobId: job.jobId,
        conversationId: job.conversationId,
        historyLength: job.history.length,
        sdkReportedCostUsd,
      },
    });

    logLine("INFO", "Agent query completed", {
      jobId: job.jobId,
      orgId: job.orgId,
      inputTokens,
      outputTokens,
      costUsd,
      responseLength: finalText.length,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logLine("ERROR", "Agent query failed", {
      jobId: job.jobId,
      orgId: job.orgId,
      error: reason,
      stack,
    });
    await failAgentQuery(db, job.jobId, reason);
  }
}

export type { AgentQueryEvent, AgentQueryEventLevel, AgentQueryEventType };
