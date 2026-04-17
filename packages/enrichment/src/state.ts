import { Annotation } from "@langchain/langgraph";
import type {
  AICallUsage,
  DecisionLog,
  DraftCar,
  DraftCircuit,
  DraftConstructor,
  DraftDriver,
  DraftDriverSeat,
  DraftGrandPrix,
  DraftIncident,
  DraftPenalty,
  DraftPitStop,
  DraftQualifyingResult,
  DraftQuote,
  DraftRaceResult,
  DraftSeason,
  DraftSprintResult,
  DraftTeamPrincipal,
  DraftTransferRumour,
  DraftTyreCompound,
} from "./types";

/**
 * De-dup helper. Keeps the FIRST occurrence (earlier tier nodes win on
 * conflicts, e.g. if both extractDrivers and a later node emit the same
 * driver the first wins). The key is the caller's responsibility.
 */
function mergeBy<T>(
  a: readonly T[],
  b: readonly T[],
  keyOf: (x: T) => string,
): T[] {
  const seen = new Set(a.map(keyOf));
  const out = [...a];
  for (const item of b) {
    const k = keyOf(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

const byEntityId = <T extends { entityId: string }>(x: T) => x.entityId;
const byNameLower = <T extends { name: string }>(x: T) =>
  x.name.toLowerCase();
const byDriverNameLower = <T extends { name: string }>(x: T) =>
  x.name.toLowerCase();

// Reference entities dedup by nameLower (multiple aliases → same driver).
function refReducer<T extends { entityId: string; name: string }>(
  a: T[],
  b: T[],
): T[] {
  return mergeBy(a, b, byNameLower);
}

// Fact documents dedup by entityId (caller pre-generates unique ids per fact).
function factReducer<T extends { entityId: string }>(a: T[], b: T[]): T[] {
  return mergeBy(a, b, byEntityId);
}

/**
 * LangGraph state annotation for the F1 enrichment workflow.
 *
 * Each tier node emits a partial state update containing the per-type arrays
 * it owns. Reducers merge into the accumulating state so downstream nodes can
 * read earlier-tier output via `state.drivers`, `state.constructors`, etc.
 */
export const EnrichmentStateAnnotation = Annotation.Root({
  // --- Input ---
  orgId: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  fileId: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  text: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  sourceChunkIds: Annotation<string[]>({
    reducer: (_, b) => b,
    default: () => [],
  }),

  // --- Tier 1: reference entities ---
  drivers: Annotation<DraftDriver[]>({
    reducer: refReducer,
    default: () => [],
  }),
  constructors: Annotation<DraftConstructor[]>({
    reducer: refReducer,
    default: () => [],
  }),
  teamPrincipals: Annotation<DraftTeamPrincipal[]>({
    reducer: refReducer,
    default: () => [],
  }),
  circuits: Annotation<DraftCircuit[]>({
    reducer: refReducer,
    default: () => [],
  }),
  seasons: Annotation<DraftSeason[]>({
    reducer: (a, b) =>
      mergeBy(a, b, (s) =>
        s.year !== undefined ? `year:${s.year}` : byDriverNameLower(s),
      ),
    default: () => [],
  }),
  grandsPrix: Annotation<DraftGrandPrix[]>({
    reducer: refReducer,
    default: () => [],
  }),
  driverSeats: Annotation<DraftDriverSeat[]>({
    reducer: factReducer,
    default: () => [],
  }),

  // --- Tier 2: results (numeric-heavy) ---
  raceResults: Annotation<DraftRaceResult[]>({
    reducer: factReducer,
    default: () => [],
  }),
  qualifyingResults: Annotation<DraftQualifyingResult[]>({
    reducer: factReducer,
    default: () => [],
  }),
  sprintResults: Annotation<DraftSprintResult[]>({
    reducer: factReducer,
    default: () => [],
  }),
  pitStops: Annotation<DraftPitStop[]>({
    reducer: factReducer,
    default: () => [],
  }),

  // --- Tier 3: regulatory ---
  incidents: Annotation<DraftIncident[]>({
    reducer: factReducer,
    default: () => [],
  }),
  penalties: Annotation<DraftPenalty[]>({
    reducer: factReducer,
    default: () => [],
  }),

  // --- Tier 4: contextual ---
  cars: Annotation<DraftCar[]>({
    reducer: factReducer,
    default: () => [],
  }),
  tyreCompounds: Annotation<DraftTyreCompound[]>({
    reducer: factReducer,
    default: () => [],
  }),
  quotes: Annotation<DraftQuote[]>({
    reducer: factReducer,
    default: () => [],
  }),
  transferRumours: Annotation<DraftTransferRumour[]>({
    reducer: factReducer,
    default: () => [],
  }),

  // --- Tracking ---
  decisions: Annotation<DecisionLog[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  aiCalls: Annotation<AICallUsage[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  errors: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),

  // --- Control flow ---
  retryCount: Annotation<number>({
    reducer: (_, b) => b,
    default: () => 0,
  }),
  validationPassed: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
});

export type EnrichmentState = typeof EnrichmentStateAnnotation.State;
export type EnrichmentStateInput = Partial<EnrichmentState>;
