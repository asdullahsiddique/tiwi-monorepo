import OpenAI from "openai";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  getMongoDb,
  FileRepository,
  LogRepository,
  CustomPromptRepository,
  type SimilarChunk,
  type CustomPromptRecord,
} from "@tiwi/mongodb";
import { executeTool, toolDefinitions } from "./searchTools";

const SearchEnvSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  OPENAI_SEARCH_MODEL: z.string().min(1).default("gpt-5-mini"),
  OPENAI_PRICE_INPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0),
  OPENAI_PRICE_OUTPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0),
});

function getSearchEnv(env: NodeJS.ProcessEnv = process.env) {
  return SearchEnvSchema.parse(env);
}

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

export type SearchCitation = {
  fileId: string;
  chunkId: string;
  score: number;
  snippet: string;
};

export type SearchToolCallLog = {
  name: string;
  arguments: string;
  /** Stringified (truncated) tool response — kept for debugging only. */
  resultPreview: string;
  durationMs: number;
};

export type SemanticSearchResult = {
  answer: string;
  citations: SearchCitation[];
  chunks: SimilarChunk[];
  relatedFiles: Array<{
    fileId: string;
    originalName: string;
    contentType: string;
  }>;
  /** Observability: every tool call the LLM made while answering. */
  toolCalls: SearchToolCallLog[];
  /** Prompts that were applied (if any). */
  appliedPromptIds: string[];
};

const SYSTEM_PROMPT = `You are an F1 research assistant answering user questions using a set of tools that query a private F1 knowledge base (race results, qualifying, pit stops, incidents, penalties, quotes, and indexed document chunks).

## How to answer

1. Decide which tool(s) the question needs:
   - Use stat / count / stats tools (count_metric, sum_points, avg_pit_stop_ms, driver_season_stats, constructor_season_stats) when the question asks for a number or a deterministic metric. These are always-correct.
   - Use list tools (list_race_results, list_qualifying_results, list_sprint_results, list_pit_stops, list_incidents, list_penalties) when the question asks for a ranking, a detailed breakdown, or multiple rows.
   - Use lookup tools (lookup_driver, lookup_constructor, lookup_grand_prix, lookup_season, lookup_circuit) only when you need to confirm an entity exists or fetch its metadata.
   - Use search_document_chunks for narrative / qualitative / descriptive questions, quotes, incident reasoning, or anything that is not tabular.
2. You MAY call multiple tools in parallel if they are independent (e.g. comparing two drivers).
3. You MAY call additional tools based on earlier results.
4. When you have enough information, stop calling tools and write a direct, concise answer in prose.

## Answer style

- Be concise and factual. Quote numbers exactly as returned.
- When you use values from list tools, the raw numeric fields are authoritative (e.g. raceTimeMs, durationMs). Format durations as seconds with 3 decimals (raceTimeMs/1000).
- If a tool returned \`{ found: false }\` or \`{ error: ... }\`, acknowledge the missing data honestly rather than guessing.
- Cite chunks by their chunkId when you used narrative text from search_document_chunks.
- Do not invent entities, results, or quotes that the tools did not return.`;

const MAX_TOOL_ROUNDS = 5;

export async function semanticSearch(params: {
  orgId: string;
  query: string;
  /** Unused in tool-calling mode but kept for API compat. */
  topK?: number;
  /** Optional ordered list of custom prompt ids to apply to this query. */
  promptIds?: string[];
}): Promise<SemanticSearchResult> {
  const env = getSearchEnv();
  const nowIso = new Date().toISOString();

  const db = await getMongoDb();
  const fileRepo = new FileRepository(db);
  const logRepo = new LogRepository(db);
  const promptRepo = new CustomPromptRepository(db);

  if (!env.OPENAI_API_KEY) {
    return {
      answer:
        "OPENAI_API_KEY is not configured. Search requires an LLM + embeddings.",
      citations: [],
      chunks: [],
      relatedFiles: [],
      toolCalls: [],
      appliedPromptIds: [],
    };
  }

  // Resolve custom prompts (org-scoped) and preserve user-supplied ordering.
  const selectedPromptIds = params.promptIds ?? [];
  const fetchedPrompts =
    selectedPromptIds.length > 0
      ? await promptRepo.getByIds({
          orgId: params.orgId,
          promptIds: selectedPromptIds,
        })
      : [];
  const promptById = new Map(fetchedPrompts.map((p) => [p.promptId, p]));
  const orderedPrompts: CustomPromptRecord[] = selectedPromptIds
    .map((id) => promptById.get(id))
    .filter((p): p is CustomPromptRecord => Boolean(p));

  const prependPrompts = orderedPrompts.filter((p) => p.placement === "prepend");
  const appendPrompts = orderedPrompts.filter((p) => p.placement === "append");
  const postProcessPrompts = orderedPrompts.filter(
    (p) => p.placement === "post_process",
  );

  const systemPromptParts: string[] = [];
  for (const p of prependPrompts) {
    systemPromptParts.push(`[Custom instruction: ${p.name}]\n${p.body}`);
  }
  systemPromptParts.push(SYSTEM_PROMPT);
  for (const p of appendPrompts) {
    systemPromptParts.push(`[Custom instruction: ${p.name}]\n${p.body}`);
  }
  const effectiveSystemPrompt = systemPromptParts.join("\n\n");

  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const collectedChunks: SimilarChunk[] = [];
  const toolCalls: SearchToolCallLog[] = [];

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: effectiveSystemPrompt },
    { role: "user", content: params.query },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalAnswer = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await openai.chat.completions.create({
      model: env.OPENAI_SEARCH_MODEL,
      messages,
      tools: toolDefinitions,
      tool_choice: "auto",
    });

    totalInputTokens += completion.usage?.prompt_tokens ?? 0;
    totalOutputTokens += completion.usage?.completion_tokens ?? 0;

    const choice = completion.choices[0];
    const msg = choice?.message;
    if (!msg) {
      finalAnswer = "No response from model.";
      break;
    }

    const toolCallsReq = msg.tool_calls ?? [];

    if (toolCallsReq.length === 0) {
      finalAnswer = msg.content ?? "";
      messages.push({ role: "assistant", content: finalAnswer });
      break;
    }

    // Persist the assistant turn with its tool_calls so that subsequent tool
    // responses can reference the right tool_call_id.
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: toolCallsReq,
    });

    // Execute every requested tool call (parallel).
    const executed = await Promise.all(
      toolCallsReq.map(async (tc) => {
        if (tc.type !== "function") {
          return {
            id: tc.id,
            name: "unknown",
            arguments: "",
            result: { error: "non_function_tool_call" } as Record<
              string,
              unknown
            >,
            durationMs: 0,
          };
        }
        const start = Date.now();
        const result = await executeTool(tc.function.name, tc.function.arguments, {
          orgId: params.orgId,
          db,
          openai,
          embeddingModel: env.OPENAI_EMBEDDING_MODEL,
          collectedChunks,
        });
        return {
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
          result,
          durationMs: Date.now() - start,
        };
      }),
    );

    for (const ex of executed) {
      const serialized = JSON.stringify(ex.result);
      toolCalls.push({
        name: ex.name,
        arguments: ex.arguments,
        resultPreview: serialized.slice(0, 500),
        durationMs: ex.durationMs,
      });
      messages.push({
        role: "tool",
        tool_call_id: ex.id,
        content: serialized,
      });
    }
  }

  if (!finalAnswer) {
    // Ran out of tool rounds without a text answer → force one final pass
    // without tools so the model must synthesize from what it has.
    const finalCompletion = await openai.chat.completions.create({
      model: env.OPENAI_SEARCH_MODEL,
      messages: [
        ...messages,
        {
          role: "system",
          content:
            "Tool budget exhausted. Write the final answer now using only the information gathered above.",
        },
      ],
    });
    totalInputTokens += finalCompletion.usage?.prompt_tokens ?? 0;
    totalOutputTokens += finalCompletion.usage?.completion_tokens ?? 0;
    finalAnswer =
      finalCompletion.choices[0]?.message?.content ??
      "Ran out of tool budget before producing an answer.";
  }

  // Apply post-process prompts sequentially: each rewrites the current answer
  // using the query + the previous answer as context. This runs WITHOUT tools
  // so it is purely a transform step.
  for (const p of postProcessPrompts) {
    const postCompletion = await openai.chat.completions.create({
      model: env.OPENAI_SEARCH_MODEL,
      messages: [
        {
          role: "system",
          content: `You are post-processing a draft answer. Apply the following instruction and return ONLY the revised answer text.\n\n[Custom instruction: ${p.name}]\n${p.body}`,
        },
        {
          role: "user",
          content: `Original question: ${params.query}\n\nDraft answer:\n${finalAnswer}`,
        },
      ],
    });
    totalInputTokens += postCompletion.usage?.prompt_tokens ?? 0;
    totalOutputTokens += postCompletion.usage?.completion_tokens ?? 0;
    const revised = postCompletion.choices[0]?.message?.content;
    if (revised && revised.trim().length > 0) {
      finalAnswer = revised;
    }
  }

  const costUsd = estimateCostUsd({
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    priceInputPer1M: env.OPENAI_PRICE_INPUT_PER_1M_USD,
    priceOutputPer1M: env.OPENAI_PRICE_OUTPUT_PER_1M_USD,
  });

  await logRepo.appendAIExecutionLog({
    orgId: params.orgId,
    logId: nanoid(),
    model: env.OPENAI_SEARCH_MODEL,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    costUsd,
    purpose: "search:tool_loop",
    metadata: {
      createdAtIso: nowIso,
      toolCallCount: toolCalls.length,
      promptIds: orderedPrompts.map((p) => p.promptId),
      prependPromptCount: prependPrompts.length,
      appendPromptCount: appendPrompts.length,
      postProcessPromptCount: postProcessPrompts.length,
    },
  });

  // Build citations / related files from whatever search_document_chunks
  // called along the way.
  const uniqueChunks = dedupeChunks(collectedChunks);
  const citations: SearchCitation[] = uniqueChunks.map((c) => ({
    fileId: c.fileId,
    chunkId: c.chunkId,
    score: c.score,
    snippet: c.text.slice(0, 200),
  }));

  const relatedFiles = await fileRepo.getFilesByIds({
    orgId: params.orgId,
    fileIds: Array.from(new Set(uniqueChunks.map((c) => c.fileId))),
  });

  return {
    answer: finalAnswer,
    citations,
    chunks: uniqueChunks,
    relatedFiles: relatedFiles.map((f) => ({
      fileId: f.fileId,
      originalName: f.originalName,
      contentType: f.contentType,
    })),
    toolCalls,
    appliedPromptIds: orderedPrompts.map((p) => p.promptId),
  };
}

function dedupeChunks(chunks: SimilarChunk[]): SimilarChunk[] {
  const seen = new Map<string, SimilarChunk>();
  for (const c of chunks) {
    const existing = seen.get(c.chunkId);
    if (!existing || c.score > existing.score) {
      seen.set(c.chunkId, c);
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.score - a.score);
}
