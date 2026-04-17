import OpenAI from "openai";
import type { z } from "zod";
import { getLangGraphEnv } from "../env";
import type { AICallUsage, DecisionLog } from "../types";

export type LlmJsonCallParams<TSchema extends z.ZodTypeAny> = {
  purpose: string;
  systemPrompt: string;
  userPrompt: string;
  schema: TSchema;
  /** Force a specific model; default uses OPENAI_ENRICHMENT_MODEL. */
  model?: string;
  /** When true, disable response_format JSON mode (rarely needed). */
  plainText?: boolean;
};

export type LlmJsonCallResult<T> =
  | { ok: true; data: T; aiCall: AICallUsage; decisions: DecisionLog[] }
  | {
      ok: false;
      error: string;
      aiCall?: AICallUsage;
      decisions: DecisionLog[];
    };

function calculateCost(
  inputTokens: number,
  outputTokens: number,
  inputPricePer1M: number,
  outputPricePer1M: number,
): number {
  return (
    (inputTokens * inputPricePer1M + outputTokens * outputPricePer1M) /
    1_000_000
  );
}

/**
 * Calls OpenAI in JSON mode, validates with zod, and attaches token/cost
 * bookkeeping as an AICallUsage record. Used by every extraction node so the
 * nodes themselves stay focused on prompt construction and post-processing.
 */
export async function llmJsonCall<TSchema extends z.ZodTypeAny>(
  params: LlmJsonCallParams<TSchema>,
): Promise<LlmJsonCallResult<z.infer<TSchema>>> {
  const env = getLangGraphEnv();
  const decisions: DecisionLog[] = [];
  const now = new Date().toISOString();

  if (!env.OPENAI_API_KEY) {
    decisions.push({
      level: "WARN",
      message: `${params.purpose}: OPENAI_API_KEY not set, skipping`,
      createdAtIso: now,
    });
    return { ok: false, error: "OPENAI_API_KEY not set", decisions };
  }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const model = params.model ?? env.OPENAI_ENRICHMENT_MODEL;

  try {
    const response = await client.chat.completions.create({
      model,
      // temperature: 0,
      response_format: params.plainText ? undefined : { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            params.systemPrompt +
            "\n\nYou MUST respond with valid JSON only. Numeric fields MUST be JSON numbers, NOT strings.",
        },
        { role: "user", content: params.userPrompt },
      ],
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;

    const aiCall: AICallUsage = {
      model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd: calculateCost(
        inputTokens,
        outputTokens,
        env.OPENAI_PRICE_INPUT_PER_1M_USD,
        env.OPENAI_PRICE_OUTPUT_PER_1M_USD,
      ),
      purpose: params.purpose,
      createdAtIso: now,
    };

    let parsed: z.infer<TSchema>;
    try {
      const raw = JSON.parse(content);
      parsed = params.schema.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      decisions.push({
        level: "WARN",
        message: `${params.purpose}: failed to parse LLM response — ${msg}`,
        createdAtIso: new Date().toISOString(),
        metadata: { rawContent: content.slice(0, 500) },
      });
      return { ok: false, error: msg, aiCall, decisions };
    }

    return { ok: true, data: parsed, aiCall, decisions };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    decisions.push({
      level: "WARN",
      message: `${params.purpose}: LLM call failed — ${msg}`,
      createdAtIso: new Date().toISOString(),
    });
    return { ok: false, error: msg, decisions };
  }
}
