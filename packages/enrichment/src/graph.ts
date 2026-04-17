import { END, START, StateGraph } from "@langchain/langgraph";
import { EnrichmentStateAnnotation, type EnrichmentState } from "./state";
import type { F1LookupStore } from "./f1LookupStore";
import { createExtractDriversNode } from "./nodes/extractDrivers";
import { createExtractConstructorsAndSeatsNode } from "./nodes/extractConstructorsAndSeats";
import { createExtractCircuitsAndSeasonsNode } from "./nodes/extractCircuitsAndSeasons";
import { createExtractGrandsPrixNode } from "./nodes/extractGrandsPrix";
import { createExtractResultsNode } from "./nodes/extractResults";
import { createExtractIncidentsAndPenaltiesNode } from "./nodes/extractIncidentsAndPenalties";
import { createExtractMediaEntitiesNode } from "./nodes/extractMediaEntities";
import { validateOutput } from "./nodes/validateOutput";

/**
 * Tier-ordered F1 enrichment graph.
 *
 * Each node extracts one or more document types. Later nodes can read
 * earlier-tier output from state for foreign-key resolution (driverId,
 * constructorId, etc.), with the injected `lookupStore` as a fallback for
 * entities persisted by previous files.
 */
export function buildEnrichmentGraph(lookupStore: F1LookupStore) {
  const graph = new StateGraph(EnrichmentStateAnnotation)
    .addNode("extractDrivers", createExtractDriversNode(lookupStore))
    .addNode(
      "extractConstructorsAndSeats",
      createExtractConstructorsAndSeatsNode(lookupStore),
    )
    .addNode(
      "extractCircuitsAndSeasons",
      createExtractCircuitsAndSeasonsNode(lookupStore),
    )
    .addNode("extractGrandsPrix", createExtractGrandsPrixNode(lookupStore))
    .addNode("extractResults", createExtractResultsNode(lookupStore))
    .addNode(
      "extractIncidentsAndPenalties",
      createExtractIncidentsAndPenaltiesNode(lookupStore),
    )
    .addNode(
      "extractMediaEntities",
      createExtractMediaEntitiesNode(lookupStore),
    )
    .addNode("validateOutput", validateOutput)
    .addEdge(START, "extractDrivers")
    .addEdge("extractDrivers", "extractConstructorsAndSeats")
    .addEdge("extractConstructorsAndSeats", "extractCircuitsAndSeasons")
    .addEdge("extractCircuitsAndSeasons", "extractGrandsPrix")
    .addEdge("extractGrandsPrix", "extractResults")
    .addEdge("extractResults", "extractIncidentsAndPenalties")
    .addEdge("extractIncidentsAndPenalties", "extractMediaEntities")
    .addEdge("extractMediaEntities", "validateOutput")
    .addEdge("validateOutput", END);

  return graph.compile();
}

export type EnrichmentGraph = ReturnType<typeof buildEnrichmentGraph>;
export type { EnrichmentState };
