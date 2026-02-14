import { getLangGraphEnv } from "./env";
import { enrichmentGraph } from "./graph";
import type { EnrichmentResult, EnrichmentContext } from "./types";
import type { EnrichmentStateInput } from "./state";

/**
 * Run the LangGraph enrichment pipeline on a file.
 * 
 * This function:
 * 1. Extracts entities from the text using structured output
 * 2. Validates and registers new entity types
 * 3. Resolves extracted entities against existing entities
 * 4. Extracts relationships between entities
 * 5. Validates the final output
 * 
 * The graph uses dynamic Neo4j labels - each entity type becomes its own
 * label (e.g., :Person, :Organization, :Invoice) rather than a generic :Entity.
 */
export async function enrichFile(params: {
  orgId: string;
  userId: string;
  fileId: string;
  text: string;
  context?: EnrichmentContext;
}): Promise<EnrichmentResult> {
  const env = getLangGraphEnv();
  const nowIso = new Date().toISOString();

  // Check for API key
  if (!env.OPENAI_API_KEY) {
    return {
      createdTypes: [],
      entities: [],
      relationships: [],
      resolvedMatches: [],
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

  // Prepare initial state for the graph
  const initialState: EnrichmentStateInput = {
    text: params.text.slice(0, 50_000), // Limit text size
    existingTypes: params.context?.existingTypes ?? [],
    existingEntities: params.context?.existingEntities ?? [],
  };

  try {
    // Invoke the LangGraph enrichment pipeline
    const result = await enrichmentGraph.invoke(initialState);

    // Map graph state to EnrichmentResult
    return {
      createdTypes: result.createdTypes ?? [],
      entities: result.entities ?? [],
      relationships: result.relationships ?? [],
      resolvedMatches: result.resolvedMatches ?? [],
      aiCalls: result.aiCalls ?? [],
      decisions: result.decisions ?? [],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    return {
      createdTypes: [],
      entities: [],
      relationships: [],
      resolvedMatches: [],
      aiCalls: [],
      decisions: [
        {
          level: "WARN",
          message: `LangGraph enrichment failed: ${errorMessage}`,
          createdAtIso: nowIso,
        },
      ],
    };
  }
}
