import { z } from "zod";
import OpenAI from "openai";
import type { EnrichmentState } from "../state";
import type { AICallUsage, DecisionLog, ResolvedMatch, ExtractedEntity } from "../types";
import { getLangGraphEnv } from "../env";

/**
 * Schema for entity resolution response from the LLM.
 */
const EntityResolutionResponseSchema = z.object({
  matches: z.array(
    z.object({
      extractedName: z.string(),
      extractedTypeName: z.string(),
      matchedExistingEntityId: z.string(),
      matchedExistingName: z.string(),
      matchedExistingTypeName: z.string(),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
    })
  ).default([]),
  updatedEntities: z.array(
    z.object({
      originalName: z.string(),
      typeName: z.string(),
      resolvedName: z.string(),
      matchedExistingEntityId: z.string().optional(),
    })
  ).default([]),
});

type EntityResolutionResponse = z.infer<typeof EntityResolutionResponseSchema>;

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
 * Build system prompt for entity resolution.
 */
function buildSystemPrompt(state: EnrichmentState): string {
  const existingEntitiesList = state.existingEntities.length > 0
    ? state.existingEntities
        .map((e) => `- [${e.entityId}] ${e.typeName}: "${e.name}" (mentioned ${e.mentionCount ?? 0} times)`)
        .join("\n")
    : "No existing entities.";

  return `You are an expert entity resolution system. Your task is to match newly extracted entities against existing entities in our knowledge graph.

## Existing Entities in Knowledge Graph
${existingEntitiesList}

## Rules for Entity Resolution
1. Match entities that refer to the SAME real-world entity
2. Be flexible with naming variations:
   - "Nerd Camels" and "Nerd Camels FZCO" are the SAME organization
   - "John Smith" and "J. Smith" might be the same person
   - "Apple Inc." and "Apple" are the same company
3. Only match entities of COMPATIBLE types (e.g., Person to Person, not Person to Organization)
4. Assign high confidence (0.9+) for exact matches
5. Assign medium confidence (0.6-0.9) for likely matches with name variations
6. Assign low confidence (0.3-0.6) for possible matches that need verification
7. Don't force matches - only match when you're reasonably confident

## Output Format
Return:
- matches: Array of matched entity pairs with confidence and reasoning
- updatedEntities: Updated entity list where matched entities get the existing entityId`;
}

/**
 * Resolve extracted entities against existing entities in the knowledge graph.
 * Uses LLM for fuzzy matching with context understanding.
 */
export async function resolveEntities(
  state: EnrichmentState
): Promise<Partial<EnrichmentState>> {
  const env = getLangGraphEnv();
  const now = new Date().toISOString();

  const decisions: DecisionLog[] = [];

  // Skip resolution if no existing entities to match against
  if (state.existingEntities.length === 0) {
    decisions.push({
      level: "INFO",
      message: "Skipping entity resolution: no existing entities to match against",
      createdAtIso: now,
    });
    return { decisions };
  }

  // Skip if no extracted entities
  if (state.entities.length === 0) {
    decisions.push({
      level: "INFO",
      message: "Skipping entity resolution: no extracted entities",
      createdAtIso: now,
    });
    return { decisions };
  }

  decisions.push({
    level: "INFO",
    message: `Starting entity resolution: ${state.entities.length} extracted vs ${state.existingEntities.length} existing`,
    createdAtIso: now,
  });

  if (!env.OPENAI_API_KEY) {
    decisions.push({
      level: "WARN",
      message: "OPENAI_API_KEY not set, skipping entity resolution",
      createdAtIso: now,
    });
    return { decisions };
  }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const systemPrompt = buildSystemPrompt(state);
  const extractedList = state.entities
    .map((e) => `- ${e.typeName}: "${e.name}"${e.properties ? ` (${JSON.stringify(e.properties)})` : ""}`)
    .join("\n");

  const userPrompt = `Match the following extracted entities against the existing entities in our knowledge graph. Return a JSON object with "matches" and "updatedEntities" arrays.

## Extracted Entities
${extractedList}

Find all matches and return the updated entity list with resolution applied.`;

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
    let parsed: EntityResolutionResponse;
    try {
      const rawJson = JSON.parse(content);
      parsed = EntityResolutionResponseSchema.parse(rawJson);
    } catch (parseError) {
      decisions.push({
        level: "WARN",
        message: `Failed to parse resolution response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        createdAtIso: new Date().toISOString(),
      });
      return { decisions, errors: ["Failed to parse resolution response"] };
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
      purpose: "entity_resolution",
      createdAtIso: now,
    };

    // Process matches
    const resolvedMatches: ResolvedMatch[] = parsed.matches.map((m) => ({
      extractedName: m.extractedName,
      extractedTypeName: m.extractedTypeName,
      matchedExistingEntityId: m.matchedExistingEntityId,
      matchedExistingName: m.matchedExistingName,
      matchedExistingTypeName: m.matchedExistingTypeName,
      confidence: m.confidence,
      reason: m.reason,
    }));

    // Update entities with matched IDs
    const updatedEntities: ExtractedEntity[] = state.entities.map((entity) => {
      const match = parsed.updatedEntities.find(
        (u) =>
          u.originalName.toLowerCase() === entity.name.toLowerCase() &&
          u.typeName === entity.typeName
      );

      if (match?.matchedExistingEntityId) {
        return {
          ...entity,
          matchedExistingEntityId: match.matchedExistingEntityId,
          name: match.resolvedName, // Use canonical name
        };
      }

      return entity;
    });

    decisions.push({
      level: "INFO",
      message: `Entity resolution complete: ${resolvedMatches.length} matches found`,
      createdAtIso: new Date().toISOString(),
      metadata: {
        matchCount: resolvedMatches.length,
        matches: resolvedMatches.map((m) => `${m.extractedName} -> ${m.matchedExistingName}`),
      },
    });

    return {
      entities: updatedEntities,
      resolvedMatches,
      aiCalls: [aiCall],
      decisions,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    decisions.push({
      level: "WARN",
      message: `Entity resolution failed: ${errorMessage}`,
      createdAtIso: new Date().toISOString(),
    });

    return {
      decisions,
      errors: [errorMessage],
    };
  }
}
