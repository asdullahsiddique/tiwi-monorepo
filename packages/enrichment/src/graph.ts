import { StateGraph, END, START } from "@langchain/langgraph";
import { EnrichmentStateAnnotation, type EnrichmentState } from "./state";
import { extractEntities } from "./nodes/extractEntities";
import { resolveEntities } from "./nodes/resolveEntities";
import { extractRelationships } from "./nodes/extractRelationships";
import { validateTypes } from "./nodes/validateTypes";
import { validateOutput } from "./nodes/validateOutput";

/**
 * Conditional edge: Should we retry extraction?
 * Routes back to extractEntities if validation failed and we can retry.
 */
function shouldRetry(state: EnrichmentState): "extractEntities" | "__end__" {
  return state.validationPassed ? "__end__" : "extractEntities";
}

/**
 * Build and compile the enrichment graph.
 * 
 * Graph flow (linear, with internal conditional logic in each node):
 * START -> extractEntities -> validateTypes -> resolveEntities -> extractRelationships -> validateOutput -> [retry?] -> END
 * 
 * Each node handles its own conditional logic:
 * - validateTypes: skips if no proposed types
 * - resolveEntities: skips if no existing entities to match against
 * - validateOutput: determines if retry is needed
 */
export function buildEnrichmentGraph() {
  const graph = new StateGraph(EnrichmentStateAnnotation)
    // Add all nodes
    .addNode("extractEntities", extractEntities)
    .addNode("validateTypes", validateTypes)
    .addNode("resolveEntities", resolveEntities)
    .addNode("extractRelationships", extractRelationships)
    .addNode("validateOutput", validateOutput)
    
    // Linear flow: each node decides internally what to do
    .addEdge(START, "extractEntities")
    .addEdge("extractEntities", "validateTypes")
    .addEdge("validateTypes", "resolveEntities")
    .addEdge("resolveEntities", "extractRelationships")
    .addEdge("extractRelationships", "validateOutput")
    .addConditionalEdges("validateOutput", shouldRetry, {
      extractEntities: "extractEntities",
      __end__: END,
    });

  return graph.compile();
}

/**
 * The compiled enrichment graph.
 * Call with initial state to run the full extraction pipeline.
 */
export const enrichmentGraph = buildEnrichmentGraph();

export type EnrichmentGraphType = typeof enrichmentGraph;
