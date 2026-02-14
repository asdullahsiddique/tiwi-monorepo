import OpenAI from "openai";
import { z } from "zod";
import { getLangGraphEnv } from "./env";
import type { EnrichmentResult } from "./types";

const EnrichmentSchema = z.object({
  createdTypes: z
    .array(
      z.object({
        typeName: z.string().min(1).max(64),
        description: z.string().min(1).max(500),
      }),
    )
    .default([]),
  entities: z
    .array(
      z.object({
        typeName: z.string().min(1).max(64),
        name: z.string().min(1).max(256),
        properties: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
  relationships: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        relationshipType: z.string().min(1).max(64),
        properties: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
  decisions: z
    .array(
      z.object({
        level: z.enum(["INFO", "WARN"]),
        message: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
});

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

/**
 * v1: best-effort enrichment.\n+ * If no OpenAI key is configured, returns empty structure with a decision note.
 */
export async function enrichFile(params: {
  orgId: string;
  userId: string;
  fileId: string;
  text: string;
}): Promise<EnrichmentResult> {
  const env = getLangGraphEnv();
  const nowIso = new Date().toISOString();

  if (!env.OPENAI_API_KEY) {
    return {
      createdTypes: [],
      entities: [],
      relationships: [],
      aiCalls: [],
      decisions: [
        {
          level: "WARN",
          message: "OPENAI_API_KEY not set; skipping enrichment and returning empty graph.",
          createdAtIso: nowIso,
        },
      ],
    };
  }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const model = env.OPENAI_ENRICHMENT_MODEL;

  const prompt = [
    "You are a graph-building agent. Convert the following file text into structured entities and relationships.",
    "Rules:",
    "- Prefer reusing common type names (Person, Organization, Location, Event, Vehicle, Product, Date, Money, Document) unless a new type is truly needed.",
    "- If you create a new type, include a short, precise description.",
    "- Entities should have stable 'name' values; relationships should reference entities by name (from/to).",
    "- Return ONLY valid JSON matching the provided schema.",
    "",
    "FILE_TEXT:",
    params.text.slice(0, 25_000),
  ].join("\n");

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You extract structured entities/relationships for a Neo4j knowledge graph. Output JSON only.",
      },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  const parsed = EnrichmentSchema.parse(JSON.parse(content));

  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  const totalTokens = response.usage?.total_tokens ?? inputTokens + outputTokens;
  const costUsd = estimateCostUsd({
    inputTokens,
    outputTokens,
    priceInputPer1M: env.OPENAI_PRICE_INPUT_PER_1M_USD,
    priceOutputPer1M: env.OPENAI_PRICE_OUTPUT_PER_1M_USD,
  });

  return {
    createdTypes: parsed.createdTypes,
    entities: parsed.entities,
    relationships: parsed.relationships,
    decisions: parsed.decisions.map((d) => ({ ...d, createdAtIso: nowIso })),
    aiCalls: [
      {
        model,
        inputTokens,
        outputTokens,
        totalTokens,
        costUsd,
        purpose: "langgraph:file_enrichment",
        createdAtIso: nowIso,
      },
    ],
  };
}

