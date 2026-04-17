import { buildEnrichmentGraph } from "./graph";
import type { F1LookupStore } from "./f1LookupStore";
import type { EnrichmentStateInput } from "./state";
import type { F1EnrichmentResult } from "./types";
import { getLangGraphEnv } from "./env";

/**
 * Run the F1 enrichment graph against a document's text and return typed,
 * per-type draft arrays ready for persistence by the caller.
 *
 * The caller (daemon) is responsible for:
 *   - Building the lookup store (F1Repository → F1LookupStore).
 *   - Persisting the returned drafts in dependency order (reference entities
 *     before facts).
 */
export async function runFileEnrichment(params: {
  orgId: string;
  fileId: string;
  text: string;
  sourceChunkIds: string[];
  lookupStore: F1LookupStore;
}): Promise<F1EnrichmentResult> {
  const env = getLangGraphEnv();
  const now = new Date().toISOString();

  const empty: F1EnrichmentResult = {
    drivers: [],
    constructors: [],
    teamPrincipals: [],
    circuits: [],
    seasons: [],
    grandsPrix: [],
    driverSeats: [],
    raceResults: [],
    qualifyingResults: [],
    sprintResults: [],
    pitStops: [],
    incidents: [],
    penalties: [],
    cars: [],
    tyreCompounds: [],
    quotes: [],
    transferRumours: [],
    decisions: [],
    aiCalls: [],
    errors: [],
  };

  if (!env.OPENAI_API_KEY) {
    return {
      ...empty,
      decisions: [
        {
          level: "WARN",
          message:
            "OPENAI_API_KEY not set; skipping F1 enrichment and returning empty result.",
          createdAtIso: now,
        },
      ],
    };
  }

  const graph = buildEnrichmentGraph(params.lookupStore);

  const initial: EnrichmentStateInput = {
    orgId: params.orgId,
    fileId: params.fileId,
    text: params.text.slice(0, 50_000),
    sourceChunkIds: params.sourceChunkIds,
  };

  try {
    const result = await graph.invoke(initial);
    return {
      drivers: result.drivers ?? [],
      constructors: result.constructors ?? [],
      teamPrincipals: result.teamPrincipals ?? [],
      circuits: result.circuits ?? [],
      seasons: result.seasons ?? [],
      grandsPrix: result.grandsPrix ?? [],
      driverSeats: result.driverSeats ?? [],
      raceResults: result.raceResults ?? [],
      qualifyingResults: result.qualifyingResults ?? [],
      sprintResults: result.sprintResults ?? [],
      pitStops: result.pitStops ?? [],
      incidents: result.incidents ?? [],
      penalties: result.penalties ?? [],
      cars: result.cars ?? [],
      tyreCompounds: result.tyreCompounds ?? [],
      quotes: result.quotes ?? [],
      transferRumours: result.transferRumours ?? [],
      decisions: result.decisions ?? [],
      aiCalls: result.aiCalls ?? [],
      errors: result.errors ?? [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...empty,
      decisions: [
        {
          level: "WARN",
          message: `F1 enrichment graph failed: ${message}`,
          createdAtIso: new Date().toISOString(),
        },
      ],
      errors: [message],
    };
  }
}
