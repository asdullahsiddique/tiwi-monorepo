import type { EnrichmentState } from "../state";
import type { DecisionLog } from "../types";

/**
 * Validate extracted facts before persistence.
 *
 * - Drops fact documents whose numeric fields are not numbers (defensive; zod
 *   already rejects those, but belt-and-braces).
 * - Drops fact documents with required FK missing AND confidence < 0.7
 *   (avoids inserting worthless orphans; borderline-confidence records with
 *   an FK are kept).
 * - Always sets validationPassed = true: we never retry. If the LLM produced
 *   nothing useful we prefer to surface zero entities rather than burn tokens
 *   on retries.
 */
export async function validateOutput(
  state: EnrichmentState,
): Promise<Partial<EnrichmentState>> {
  const decisions: DecisionLog[] = [];
  const now = new Date().toISOString();

  const isNumeric = (v: unknown): boolean =>
    v === undefined || (typeof v === "number" && Number.isFinite(v));

  const numericFactFields = [
    "position",
    "points",
    "gridPosition",
    "laps",
    "raceTimeMs",
    "gapToWinnerMs",
    "fastestLapTimeMs",
    "q1Ms",
    "q2Ms",
    "q3Ms",
    "durationMs",
    "lap",
    "stopNumber",
    "value",
  ] as const;

  function filterNumeric<T extends Record<string, unknown>>(
    coll: string,
    items: T[],
  ): T[] {
    return items.filter((item) => {
      for (const f of numericFactFields) {
        const v = item[f];
        if (!isNumeric(v)) {
          decisions.push({
            level: "WARN",
            message: `${coll}: dropped record with non-numeric "${f}"=${JSON.stringify(v)}`,
            createdAtIso: now,
          });
          return false;
        }
      }
      return true;
    });
  }

  const raceResults = filterNumeric("raceResults", state.raceResults).filter(
    (r) => {
      const confidence = r.provenance[0]?.confidence ?? 1;
      if (!r.driverId && confidence < 0.7) {
        decisions.push({
          level: "WARN",
          message: `raceResults: dropped low-confidence (${confidence.toFixed(2)}) record missing driverId`,
          createdAtIso: now,
        });
        return false;
      }
      return true;
    },
  );

  const qualifyingResults = filterNumeric(
    "qualifyingResults",
    state.qualifyingResults,
  ).filter((r) => {
    const confidence = r.provenance[0]?.confidence ?? 1;
    if (!r.driverId && confidence < 0.7) {
      decisions.push({
        level: "WARN",
        message: `qualifyingResults: dropped low-confidence record missing driverId`,
        createdAtIso: now,
      });
      return false;
    }
    return true;
  });

  const sprintResults = filterNumeric(
    "sprintResults",
    state.sprintResults,
  ).filter((r) => {
    const confidence = r.provenance[0]?.confidence ?? 1;
    if (!r.driverId && confidence < 0.7) return false;
    return true;
  });

  const pitStops = filterNumeric("pitStops", state.pitStops).filter((r) => {
    const confidence = r.provenance[0]?.confidence ?? 1;
    if (!r.driverId && confidence < 0.7) return false;
    return true;
  });

  const incidents = state.incidents;
  const penalties = filterNumeric("penalties", state.penalties);

  decisions.push({
    level: "INFO",
    message: `validateOutput: drivers=${state.drivers.length} constructors=${state.constructors.length} seasons=${state.seasons.length} grandsPrix=${state.grandsPrix.length} raceResults=${raceResults.length} quotes=${state.quotes.length}`,
    createdAtIso: now,
  });

  return {
    raceResults,
    qualifyingResults,
    sprintResults,
    pitStops,
    incidents,
    penalties,
    validationPassed: true,
    decisions,
  };
}
