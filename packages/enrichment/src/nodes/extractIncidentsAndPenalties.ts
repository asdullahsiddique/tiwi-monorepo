import { z } from "zod";
import { nanoid } from "nanoid";
import type { EnrichmentState } from "../state";
import type {
  DecisionLog,
  DraftIncident,
  DraftPenalty,
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

const IncidentSchema = z.object({
  driverNames: z.array(z.string()).default([]),
  grandPrixName: z.string().optional(),
  seasonYear: z.number().int().optional(),
  lap: z.number().int().optional(),
  incidentType: z
    .enum(["Collision", "Spin", "Mechanical", "OffTrack", "Other"])
    .optional(),
  description: z.string().optional(),
  causedSafetyCar: z.boolean().optional(),
  causedVirtualSafetyCar: z.boolean().optional(),
  causedRedFlag: z.boolean().optional(),
  confidence: z.number().min(0).max(1).default(0.8),
  sourceSpan: z.string().optional(),
});

const PenaltySchema = z.object({
  recipientName: z.string().optional(),
  recipientType: z.enum(["Driver", "Constructor"]).optional(),
  grandPrixName: z.string().optional(),
  seasonYear: z.number().int().optional(),
  penaltyType: z
    .enum([
      "TimePenalty",
      "GridPenalty",
      "PointsDeduction",
      "Reprimand",
      "Fine",
      "Disqualification",
    ])
    .optional(),
  value: z.number().optional(),
  unit: z
    .enum(["seconds", "grid_positions", "points", "eur", "usd", "none"])
    .optional(),
  reason: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.8),
  sourceSpan: z.string().optional(),
});

const ExtractionSchema = z.object({
  incidents: z.array(IncidentSchema).default([]),
  penalties: z.array(PenaltySchema).default([]),
});

const SYSTEM_PROMPT = `You are an expert F1 data extractor. Extract on-track INCIDENTS and regulatory PENALTIES from the text.

## incident
- driverNames: list of driver names involved (strings, resolved to IDs later).
- grandPrixName: the GP this happened at.
- seasonYear: JSON integer.
- lap: JSON integer — lap number when the incident occurred.
- incidentType: one of "Collision" | "Spin" | "Mechanical" | "OffTrack" | "Other".
- description: short prose description.
- causedSafetyCar / causedVirtualSafetyCar / causedRedFlag: booleans if explicitly stated.

## penalty
- recipientName: driver OR constructor name.
- recipientType: "Driver" | "Constructor".
- penaltyType: one of "TimePenalty" | "GridPenalty" | "PointsDeduction" | "Reprimand" | "Fine" | "Disqualification".
- value: JSON number — 5 (seconds), 3 (grid positions), 100000 (fine amount).
- unit: MUST match the value. "seconds" | "grid_positions" | "points" | "eur" | "usd" | "none".
- reason: short prose.

## Rules
1. ALL numeric fields MUST be JSON numbers. NEVER strings.
2. Every record MUST include confidence (0..1) and a short sourceSpan.
3. Do NOT invent incidents/penalties. Only extract what the text describes.

## Output
{ "incidents": [...], "penalties": [...] }`;

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

export function createExtractIncidentsAndPenaltiesNode(
  lookupStore: F1LookupStore,
) {
  return async function extractIncidentsAndPenalties(
    state: EnrichmentState,
  ): Promise<Partial<EnrichmentState>> {
    const decisions: DecisionLog[] = [];
    const now = new Date().toISOString();

    const result = await llmJsonCall({
      purpose: "extract_incidents_and_penalties",
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

    const incidents: DraftIncident[] = [];
    for (const inc of result.data.incidents) {
      const driverIds: string[] = [];
      for (const n of inc.driverNames) {
        const id = await resolveDriverId(n, state, lookupStore);
        if (id) driverIds.push(id);
      }
      const grandPrixId = await resolveGrandPrixId(
        inc.grandPrixName,
        state,
        lookupStore,
      );
      const seasonId = await resolveSeasonIdByYear(
        inc.seasonYear,
        state,
        lookupStore,
      );
      incidents.push({
        entityId: nanoid(18),
        name:
          `${inc.incidentType ?? "Incident"} @ ${inc.grandPrixName ?? "?"} lap ${inc.lap ?? "?"}`,
        provenance: [
          buildProvenance(
            state.fileId,
            state.sourceChunkIds,
            inc.sourceSpan,
            inc.confidence,
          ),
        ],
        driverIds,
        grandPrixId,
        seasonId,
        lap: inc.lap,
        incidentType: inc.incidentType,
        description: inc.description,
        causedSafetyCar: inc.causedSafetyCar,
        causedVirtualSafetyCar: inc.causedVirtualSafetyCar,
        causedRedFlag: inc.causedRedFlag,
      });
    }

    const penalties: DraftPenalty[] = [];
    for (const p of result.data.penalties) {
      let recipientId: string | undefined;
      if (p.recipientName) {
        if (p.recipientType === "Constructor") {
          recipientId = await resolveConstructorId(
            p.recipientName,
            state,
            lookupStore,
          );
        } else {
          recipientId = await resolveDriverId(
            p.recipientName,
            state,
            lookupStore,
          );
        }
      }
      const grandPrixId = await resolveGrandPrixId(
        p.grandPrixName,
        state,
        lookupStore,
      );
      const seasonId = await resolveSeasonIdByYear(
        p.seasonYear,
        state,
        lookupStore,
      );
      penalties.push({
        entityId: nanoid(18),
        name:
          `${p.penaltyType ?? "Penalty"}: ${p.recipientName ?? "?"} @ ${p.grandPrixName ?? "?"}`,
        provenance: [
          buildProvenance(
            state.fileId,
            state.sourceChunkIds,
            p.sourceSpan,
            p.confidence,
          ),
        ],
        recipientId,
        recipientType: p.recipientType,
        grandPrixId,
        seasonId,
        penaltyType: p.penaltyType,
        value: p.value,
        unit: p.unit,
        reason: p.reason,
      });
    }

    decisions.push({
      level: "INFO",
      message: `extractIncidentsAndPenalties: ${incidents.length} incidents, ${penalties.length} penalties`,
      createdAtIso: now,
    });

    return {
      incidents,
      penalties,
      aiCalls: [result.aiCall],
      decisions,
    };
  };
}
