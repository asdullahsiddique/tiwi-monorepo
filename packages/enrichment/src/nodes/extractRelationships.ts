import { z } from "zod";
import OpenAI from "openai";
import type { EnrichmentState } from "../state";
import type { AICallUsage, DecisionLog, ExtractedRelationship } from "../types";
import { getLangGraphEnv } from "../env";

/**
 * Schema for relationship extraction response from the LLM.
 */
const RelationshipExtractionResponseSchema = z.object({
  relationships: z.array(
    z.object({
      fromTypeName: z.string(),
      fromName: z.string(),
      relationshipType: z.string(),
      toTypeName: z.string(),
      toName: z.string(),
      properties: z.record(z.string(), z.unknown()).optional(),
    })
  ).default([]),
});

type RelationshipExtractionResponse = z.infer<typeof RelationshipExtractionResponseSchema>;

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
 * Build system prompt for relationship extraction.
 */
function buildSystemPrompt(state: EnrichmentState): string {
  // Build list of available entities for reference
  const entitiesList = state.entities
    .map((e) => `- ${e.typeName}: "${e.name}"`)
    .join("\n");

  return `You are an expert relationship extraction system. Your task is to identify all relationships between the entities that were extracted from the text.

## Available Entities
These entities were extracted from the text. ONLY create relationships between these entities:
${entitiesList}

## Rules for Relationship Extraction
1. Only create relationships between entities that are EXPLICITLY or STRONGLY implied in the text
2. Relationship types should be in SCREAMING_SNAKE_CASE (e.g., WORKS_AT, ISSUED_BY, PAID_TO)
3. Choose relationship names that are:
   - Clear and descriptive (WORKS_AT not RELATED_TO)
   - Directional where appropriate (MANAGES vs MANAGED_BY)
   - Domain-appropriate (BILLED_TO for invoices, EMPLOYED_BY for people)
4. Common relationship types include:
   - Organization relationships: SUBSIDIARY_OF, PARTNER_OF, ACQUIRED_BY
   - Person relationships: WORKS_AT, MANAGES, REPORTS_TO, KNOWS
   - Document relationships: ISSUED_BY, SENT_TO, SIGNED_BY, REFERENCES
   - Financial relationships: PAID_TO, INVOICED_BY, FUNDED_BY
5. Don't create vague or generic relationships
6. Include relevant properties (e.g., amount, date, role) when available

## Output Format
Return a JSON object with:
- relationships: Array of relationships with fromTypeName, fromName, relationshipType, toTypeName, toName, and optional properties`;
}

/**
 * Extract relationships between entities using OpenAI.
 */
export async function extractRelationships(
  state: EnrichmentState
): Promise<Partial<EnrichmentState>> {
  const env = getLangGraphEnv();
  const now = new Date().toISOString();

  const decisions: DecisionLog[] = [];

  // Skip if not enough entities for relationships
  if (state.entities.length < 2) {
    decisions.push({
      level: "INFO",
      message: "Skipping relationship extraction: fewer than 2 entities",
      createdAtIso: now,
    });
    return { decisions };
  }

  decisions.push({
    level: "INFO",
    message: `Starting relationship extraction between ${state.entities.length} entities`,
    createdAtIso: now,
  });

  if (!env.OPENAI_API_KEY) {
    decisions.push({
      level: "WARN",
      message: "OPENAI_API_KEY not set, skipping relationship extraction",
      createdAtIso: now,
    });
    return { decisions };
  }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const systemPrompt = buildSystemPrompt(state);
  const userPrompt = `Based on the following text, identify all relationships between the extracted entities. Return a JSON object with a "relationships" array.

## Original Text
${state.text.slice(0, 25000)}

Extract all meaningful relationships between the entities listed in the system prompt.`;

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
    let parsed: RelationshipExtractionResponse;
    try {
      const rawJson = JSON.parse(content);
      parsed = RelationshipExtractionResponseSchema.parse(rawJson);
    } catch (parseError) {
      decisions.push({
        level: "WARN",
        message: `Failed to parse relationship response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        createdAtIso: new Date().toISOString(),
      });
      return { decisions, errors: ["Failed to parse relationship response"] };
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
      purpose: "relationship_extraction",
      createdAtIso: now,
    };

    // Map response to our types
    const relationships: ExtractedRelationship[] = parsed.relationships.map((r) => ({
      fromTypeName: r.fromTypeName,
      fromName: r.fromName,
      relationshipType: r.relationshipType,
      toTypeName: r.toTypeName,
      toName: r.toName,
      properties: r.properties,
    }));

    // Validate that all relationship endpoints exist in entities
    const entityKeys = new Set(
      state.entities.map((e) => `${e.typeName}:${e.name.toLowerCase()}`)
    );

    const validRelationships = relationships.filter((r) => {
      const fromKey = `${r.fromTypeName}:${r.fromName.toLowerCase()}`;
      const toKey = `${r.toTypeName}:${r.toName.toLowerCase()}`;
      const isValid = entityKeys.has(fromKey) && entityKeys.has(toKey);

      if (!isValid) {
        decisions.push({
          level: "WARN",
          message: `Discarded invalid relationship: ${r.fromName} -[${r.relationshipType}]-> ${r.toName} (endpoint not in entities)`,
          createdAtIso: new Date().toISOString(),
        });
      }

      return isValid;
    });

    decisions.push({
      level: "INFO",
      message: `Relationship extraction complete: ${validRelationships.length} valid relationships (${relationships.length - validRelationships.length} discarded)`,
      createdAtIso: new Date().toISOString(),
      metadata: {
        validCount: validRelationships.length,
        discardedCount: relationships.length - validRelationships.length,
        relationshipTypes: [...new Set(validRelationships.map((r) => r.relationshipType))],
      },
    });

    return {
      relationships: validRelationships,
      aiCalls: [aiCall],
      decisions,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    decisions.push({
      level: "WARN",
      message: `Relationship extraction failed: ${errorMessage}`,
      createdAtIso: new Date().toISOString(),
    });

    return {
      decisions,
      errors: [errorMessage],
    };
  }
}
