import { z } from "zod";
import OpenAI from "openai";
import type { EnrichmentState } from "../state";
import type { AICallUsage, DecisionLog, ExtractedEntity, ProposedType } from "../types";
import { getLangGraphEnv } from "../env";

/**
 * Schema for the entity extraction response from the LLM.
 */
const EntityExtractionResponseSchema = z.object({
  entities: z.array(
    z.object({
      typeName: z.string(),
      name: z.string(),
      properties: z.record(z.string(), z.unknown()).optional(),
      confidence: z.number().min(0).max(1).optional(),
    })
  ).default([]),
  proposedTypes: z.array(
    z.object({
      typeName: z.string(),
      description: z.string(),
      suggestedProperties: z.array(z.string()).default([]),
    })
  ).default([]),
});

type EntityExtractionResponse = z.infer<typeof EntityExtractionResponseSchema>;

/**
 * Build the system prompt for entity extraction.
 */
function buildSystemPrompt(state: EnrichmentState): string {
  if (state.existingTypes.length === 0) {
    // Open mode: no active types defined yet — extract freely, all will become drafts
    return `You are an expert entity extraction system. Your task is to extract all meaningful entities from the given text.

## Rules for Entity Extraction
1. Extract ALL meaningful entities from the text (people, organizations, documents, amounts, dates, locations, etc.)
2. New type names must be PascalCase and singular (e.g., "Invoice" not "invoices")
3. Include relevant properties for each entity (e.g., amounts, dates, IDs)
4. Assign confidence scores (0-1) based on extraction certainty
5. Propose new types for any entity types you encounter — all proposed types will be reviewed by the user

## Output Format
Return a JSON object with:
- entities: Array of extracted entities with typeName, name, properties, confidence
- proposedTypes: Array of new types with typeName, description, and suggestedProperties (array of property name strings)

Extract entities thoroughly but avoid duplicates within the same document.`;
  }

  // Strict mode: org has active types — only extract those types
  const typesList = state.existingTypes
    .map((t) => {
      const propHint = t.properties && t.properties.length > 0
        ? ` (expected properties: ${t.properties.join(", ")})`
        : "";
      return `- ${t.typeName}${propHint}\n  ${t.description}`;
    })
    .join("\n");

  return `You are an expert entity extraction system. Your task is to extract entities from the given text using ONLY the defined schema types.

## Active Schema Types
ONLY extract entities of these types. Do not invent new types unless truly necessary:
${typesList}

## Rules for Entity Extraction
1. Extract entities that match the active schema types above
2. Use the EXACT type names as listed — do not modify them
3. Include relevant properties for each entity, especially the expected properties listed
4. Assign confidence scores (0-1) based on extraction certainty
5. Only propose a NEW type if you encounter an entity that genuinely cannot fit any existing type
6. New type names must be PascalCase and singular

## Output Format
Return a JSON object with:
- entities: Array of extracted entities with typeName, name, properties, confidence
- proposedTypes: Array of genuinely new types (only if needed) with typeName, description, and suggestedProperties (array of property name strings)

Extract entities thoroughly but avoid duplicates within the same document.`;
}

/**
 * Calculate cost estimate for OpenAI API call.
 */
function calculateCost(
  inputTokens: number,
  outputTokens: number,
  inputPricePer1M: number,
  outputPricePer1M: number
): number {
  return (inputTokens * inputPricePer1M + outputTokens * outputPricePer1M) / 1_000_000;
}

/**
 * Extract entities from text using OpenAI with JSON mode.
 */
export async function extractEntities(
  state: EnrichmentState
): Promise<Partial<EnrichmentState>> {
  const env = getLangGraphEnv();
  const now = new Date().toISOString();

  const decisions: DecisionLog[] = [
    {
      level: "INFO",
      message: `Starting entity extraction with model ${env.OPENAI_ENRICHMENT_MODEL}`,
      createdAtIso: now,
      metadata: {
        textLength: state.text.length,
        existingTypesCount: state.existingTypes.length,
        mode: state.existingTypes.length === 0 ? "open" : "strict",
      },
    },
  ];

  if (!env.OPENAI_API_KEY) {
    decisions.push({
      level: "WARN",
      message: "OPENAI_API_KEY not set, skipping entity extraction",
      createdAtIso: now,
    });
    return { decisions };
  }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const systemPrompt = buildSystemPrompt(state);
  const userPrompt = `Extract all entities from the following text. Return a JSON object with "entities" and "proposedTypes" arrays.

TEXT:
${state.text.slice(0, 25000)}`;

  try {
    const response = await client.chat.completions.create({
      model: env.OPENAI_ENRICHMENT_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt + "\n\nYou MUST respond with valid JSON only." },
        { role: "user", content: userPrompt },
      ],
    });

    const content = response.choices[0]?.message?.content ?? "{}";
    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;

    // Parse and validate response
    let parsed: EntityExtractionResponse;
    try {
      const rawJson = JSON.parse(content);
      parsed = EntityExtractionResponseSchema.parse(rawJson);
    } catch (parseError) {
      decisions.push({
        level: "WARN",
        message: `Failed to parse LLM response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        createdAtIso: new Date().toISOString(),
        metadata: { rawContent: content.slice(0, 500) },
      });
      return { decisions, errors: ["Failed to parse LLM response"] };
    }

    const aiCall: AICallUsage = {
      model: env.OPENAI_ENRICHMENT_MODEL,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd: calculateCost(
        inputTokens,
        outputTokens,
        env.OPENAI_PRICE_INPUT_PER_1M_USD,
        env.OPENAI_PRICE_OUTPUT_PER_1M_USD
      ),
      purpose: "entity_extraction",
      createdAtIso: now,
    };

    // Map response to our types
    const entities: ExtractedEntity[] = parsed.entities.map((e) => ({
      typeName: e.typeName,
      name: e.name,
      properties: e.properties,
      confidence: e.confidence ?? 0.9,
    }));

    const proposedTypes: ProposedType[] = parsed.proposedTypes.map((t) => ({
      typeName: t.typeName,
      description: t.description,
      suggestedProperties: t.suggestedProperties,
    }));

    decisions.push({
      level: "INFO",
      message: `Extracted ${entities.length} entities, proposed ${proposedTypes.length} new types`,
      createdAtIso: new Date().toISOString(),
      metadata: {
        entityTypes: [...new Set(entities.map((e) => e.typeName))],
        proposedTypeNames: proposedTypes.map((t) => t.typeName),
        entityNames: entities.slice(0, 10).map((e) => e.name),
      },
    });

    return {
      entities,
      proposedTypes,
      aiCalls: [aiCall],
      decisions,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error("[extractEntities] Error:", errorMessage);

    decisions.push({
      level: "WARN",
      message: `Entity extraction failed: ${errorMessage}`,
      createdAtIso: new Date().toISOString(),
    });

    return {
      decisions,
      errors: [errorMessage],
    };
  }
}
