import { z } from "zod";
import { nanoid } from "nanoid";
import type { EnrichmentState } from "../state";
import type {
  DecisionLog,
  DraftPitStop,
  DraftQualifyingResult,
  DraftRaceResult,
  DraftSprintResult,
  FactProvenance,
} from "../types";
import type { F1LookupStore } from "../f1LookupStore";
import { llmJsonCall } from "../util/llm";
import {
  resolveConstructorId,
  resolveDriverId,
  resolveGrandPrixId,
  resolveSeasonIdByYear,
} from "../util/resolve";

const RaceResultSchema = z.object({
  driverName: z.string().optional(),
  constructorName: z.string().optional(),
  grandPrixName: z.string().optional(),
  seasonYear: z.number().int().optional(),
  position: z.number().int().optional(),
  points: z.number().optional(),
  gridPosition: z.number().int().optional(),
  laps: z.number().int().optional(),
  status: z.enum(["Finished", "DNF", "DSQ", "DNS", "Lapped"]).optional(),
  raceTimeMs: z.number().int().optional(),
  gapToWinnerMs: z.number().int().optional(),
  fastestLapTimeMs: z.number().int().optional(),
  hadFastestLap: z.boolean().optional(),
  confidence: z.number().min(0).max(1).default(0.8),
  sourceSpan: z.string().optional(),
});

const QualifyingResultSchema = z.object({
  driverName: z.string().optional(),
  constructorName: z.string().optional(),
  grandPrixName: z.string().optional(),
  seasonYear: z.number().int().optional(),
  gridPosition: z.number().int().optional(),
  q1Ms: z.number().int().optional(),
  q2Ms: z.number().int().optional(),
  q3Ms: z.number().int().optional(),
  knockedOutIn: z.enum(["Q1", "Q2", "Q3"]).optional(),
  confidence: z.number().min(0).max(1).default(0.8),
  sourceSpan: z.string().optional(),
});

const SprintResultSchema = z.object({
  driverName: z.string().optional(),
  constructorName: z.string().optional(),
  grandPrixName: z.string().optional(),
  seasonYear: z.number().int().optional(),
  position: z.number().int().optional(),
  points: z.number().optional(),
  gridPosition: z.number().int().optional(),
  status: z.enum(["Finished", "DNF", "DSQ", "DNS"]).optional(),
  confidence: z.number().min(0).max(1).default(0.8),
  sourceSpan: z.string().optional(),
});

const PitStopSchema = z.object({
  driverName: z.string().optional(),
  constructorName: z.string().optional(),
  grandPrixName: z.string().optional(),
  seasonYear: z.number().int().optional(),
  stopNumber: z.number().int().optional(),
  lap: z.number().int().optional(),
  durationMs: z.number().int().optional(),
  tyreCompoundFrom: z.string().optional(),
  tyreCompoundTo: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.8),
  sourceSpan: z.string().optional(),
});

const ExtractionSchema = z.object({
  raceResults: z.array(RaceResultSchema).default([]),
  qualifyingResults: z.array(QualifyingResultSchema).default([]),
  sprintResults: z.array(SprintResultSchema).default([]),
  pitStops: z.array(PitStopSchema).default([]),
});

const SYSTEM_PROMPT = `You are an expert F1 data extractor. Extract every numeric RESULT fact from the text. Extracted facts will power quantitative queries, so numeric correctness is CRITICAL.

## Output types (use the ones present in the text)

### raceResult (main Grand Prix race)
- driverName, constructorName, grandPrixName: strings (will be resolved to IDs).
- seasonYear: JSON integer.
- position: JSON integer 1..20 (leave undefined for DNF).
- points: JSON number.
- gridPosition, laps: JSON integers.
- status: one of "Finished" | "DNF" | "DSQ" | "DNS" | "Lapped".
- raceTimeMs: total race time converted to MILLISECONDS as a JSON integer (e.g. "1:32:45.678" → 5565678).
- gapToWinnerMs: gap to P1 in milliseconds as JSON integer (e.g. "+12.345" → 12345).
- fastestLapTimeMs: driver's fastest lap converted to milliseconds (e.g. "1:23.456" → 83456).
- hadFastestLap: boolean — awarded the fastest-lap bonus point.
- confidence: 0..1 JSON number.
- sourceSpan: short verbatim quote (≤160 chars) from the text.

### qualifyingResult
- gridPosition: final qualifying position (1..20) as JSON integer.
- q1Ms, q2Ms, q3Ms: best lap times per session in MILLISECONDS as JSON integers.
- knockedOutIn: one of "Q1" | "Q2" | "Q3" (optional).

### sprintResult (sprint race, distinct from the main race)
- position, gridPosition: JSON integers.
- points: JSON number (sprint scoring differs from the main race).
- status: "Finished" | "DNF" | "DSQ" | "DNS".

### pitStop
- stopNumber: which stop of the race (1, 2, 3, ...).
- lap: the lap the stop occurred on.
- durationMs: stationary time in MILLISECONDS (e.g. "2.31 s" → 2310).
- tyreCompoundFrom / tyreCompoundTo: compound names ("Soft", "Medium", "Hard", "Intermediate", "Wet") or codes.

## CRITICAL Rules
1. ALL numeric fields MUST be JSON numbers. NEVER strings. Convert times and gaps to MILLISECONDS.
2. If you cannot confidently convert a number, OMIT the field — do not emit a string or zero.
3. Distinguish race vs qualifying vs sprint vs pit stop results. If the text is a race-result table, these rows belong in raceResults.
4. Every output record MUST include a confidence (0..1) and a short sourceSpan quote.
5. Do NOT invent results. Only extract numbers the text explicitly gives.

## Output
{ "raceResults": [...], "qualifyingResults": [...], "sprintResults": [...], "pitStops": [...] }`;

function buildProvenance(
  fileId: string,
  sourceChunkIds: readonly string[],
  sourceSpan: string | undefined,
  confidence: number,
): FactProvenance {
  return {
    sourceFileId: fileId,
    sourceChunkIds: [...sourceChunkIds],
    sourceSpan,
    confidence,
  };
}

export function createExtractResultsNode(lookupStore: F1LookupStore) {
  return async function extractResults(
    state: EnrichmentState,
  ): Promise<Partial<EnrichmentState>> {
    const decisions: DecisionLog[] = [];
    const now = new Date().toISOString();

    const result = await llmJsonCall({
      purpose: "extract_results",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `TEXT:\n${state.text}`,
      schema: ExtractionSchema,
    });

    decisions.push(...result.decisions);

    if (!result.ok) {
      return {
        decisions,
        errors: [result.error],
        aiCalls: result.aiCall ? [result.aiCall] : [],
      };
    }

    const raceResults: DraftRaceResult[] = [];
    for (const r of result.data.raceResults) {
      const driverId = await resolveDriverId(r.driverName, state, lookupStore);
      const constructorId = await resolveConstructorId(
        r.constructorName,
        state,
        lookupStore,
      );
      const grandPrixId = await resolveGrandPrixId(
        r.grandPrixName,
        state,
        lookupStore,
      );
      const seasonId = await resolveSeasonIdByYear(
        r.seasonYear,
        state,
        lookupStore,
      );

      if (r.driverName && !driverId) {
        decisions.push({
          level: "WARN",
          message: `raceResult: unresolved driver "${r.driverName}"`,
          createdAtIso: now,
        });
      }

      raceResults.push({
        entityId: nanoid(18),
        name:
          `${r.driverName ?? "?"} @ ${r.grandPrixName ?? "?"} (${r.seasonYear ?? "?"})`,
        provenance: [
          buildProvenance(
            state.fileId,
            state.sourceChunkIds,
            r.sourceSpan,
            r.confidence,
          ),
        ],
        driverId,
        constructorId,
        grandPrixId,
        seasonId,
        position: r.position,
        points: r.points,
        gridPosition: r.gridPosition,
        laps: r.laps,
        status: r.status,
        raceTimeMs: r.raceTimeMs,
        gapToWinnerMs: r.gapToWinnerMs,
        fastestLapTimeMs: r.fastestLapTimeMs,
        hadFastestLap: r.hadFastestLap,
      });
    }

    const qualifyingResults: DraftQualifyingResult[] = [];
    for (const r of result.data.qualifyingResults) {
      const driverId = await resolveDriverId(r.driverName, state, lookupStore);
      const constructorId = await resolveConstructorId(
        r.constructorName,
        state,
        lookupStore,
      );
      const grandPrixId = await resolveGrandPrixId(
        r.grandPrixName,
        state,
        lookupStore,
      );
      const seasonId = await resolveSeasonIdByYear(
        r.seasonYear,
        state,
        lookupStore,
      );

      qualifyingResults.push({
        entityId: nanoid(18),
        name: `Q: ${r.driverName ?? "?"} @ ${r.grandPrixName ?? "?"}`,
        provenance: [
          buildProvenance(
            state.fileId,
            state.sourceChunkIds,
            r.sourceSpan,
            r.confidence,
          ),
        ],
        driverId,
        constructorId,
        grandPrixId,
        seasonId,
        gridPosition: r.gridPosition,
        q1Ms: r.q1Ms,
        q2Ms: r.q2Ms,
        q3Ms: r.q3Ms,
        knockedOutIn: r.knockedOutIn,
      });
    }

    const sprintResults: DraftSprintResult[] = [];
    for (const r of result.data.sprintResults) {
      const driverId = await resolveDriverId(r.driverName, state, lookupStore);
      const constructorId = await resolveConstructorId(
        r.constructorName,
        state,
        lookupStore,
      );
      const grandPrixId = await resolveGrandPrixId(
        r.grandPrixName,
        state,
        lookupStore,
      );
      const seasonId = await resolveSeasonIdByYear(
        r.seasonYear,
        state,
        lookupStore,
      );

      sprintResults.push({
        entityId: nanoid(18),
        name: `Sprint: ${r.driverName ?? "?"} @ ${r.grandPrixName ?? "?"}`,
        provenance: [
          buildProvenance(
            state.fileId,
            state.sourceChunkIds,
            r.sourceSpan,
            r.confidence,
          ),
        ],
        driverId,
        constructorId,
        grandPrixId,
        seasonId,
        position: r.position,
        points: r.points,
        gridPosition: r.gridPosition,
        status: r.status,
      });
    }

    const pitStops: DraftPitStop[] = [];
    for (const r of result.data.pitStops) {
      const driverId = await resolveDriverId(r.driverName, state, lookupStore);
      const constructorId = await resolveConstructorId(
        r.constructorName,
        state,
        lookupStore,
      );
      const grandPrixId = await resolveGrandPrixId(
        r.grandPrixName,
        state,
        lookupStore,
      );
      const seasonId = await resolveSeasonIdByYear(
        r.seasonYear,
        state,
        lookupStore,
      );

      pitStops.push({
        entityId: nanoid(18),
        name: `Pit ${r.stopNumber ?? "?"}: ${r.driverName ?? "?"} @ ${r.grandPrixName ?? "?"}`,
        provenance: [
          buildProvenance(
            state.fileId,
            state.sourceChunkIds,
            r.sourceSpan,
            r.confidence,
          ),
        ],
        driverId,
        constructorId,
        grandPrixId,
        seasonId,
        stopNumber: r.stopNumber,
        lap: r.lap,
        durationMs: r.durationMs,
        tyreCompoundFrom: r.tyreCompoundFrom,
        tyreCompoundTo: r.tyreCompoundTo,
      });
    }

    decisions.push({
      level: "INFO",
      message: `extractResults: race=${raceResults.length} qual=${qualifyingResults.length} sprint=${sprintResults.length} pits=${pitStops.length}`,
      createdAtIso: now,
    });

    return {
      raceResults,
      qualifyingResults,
      sprintResults,
      pitStops,
      aiCalls: [result.aiCall],
      decisions,
    };
  };
}
