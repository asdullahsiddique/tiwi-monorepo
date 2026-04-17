import { z } from "zod";
import { nanoid } from "nanoid";
import type { EnrichmentState } from "../state";
import type { DecisionLog, DraftGrandPrix } from "../types";
import type { F1LookupStore } from "../f1LookupStore";
import { llmJsonCall } from "../util/llm";
import { resolveCircuitId, resolveSeasonIdByYear } from "../util/resolve";

const ExtractionSchema = z.object({
  grandsPrix: z
    .array(
      z.object({
        name: z.string().min(1),
        aliases: z.array(z.string()).default([]),
        circuitName: z.string().optional(),
        seasonYear: z.number().int().optional(),
        date: z.string().optional(),
        round: z.number().int().optional(),
        isSprintWeekend: z.boolean().optional(),
      }),
    )
    .default([]),
});

const SYSTEM_PROMPT = `You are an expert F1 data extractor. Extract GRAND PRIX EVENTS (races) mentioned in the text.

## grandPrix
- name: canonical GP name (e.g. "2024 Monaco Grand Prix", "2024 Italian Grand Prix"). Include the year whenever known.
- aliases: every variation used in the text ("Monaco 2024", "Monza 2024", "Italian GP"). Include the canonical name too.
- circuitName: name of the circuit this race is held at (string — will be resolved to ID).
- seasonYear: JSON integer year (e.g. 2024). NOT a string.
- date: optional ISO date.
- round: JSON integer round number within the season (e.g. 8).
- isSprintWeekend: optional boolean.

## Rules
1. "seasonYear" and "round" MUST be JSON numbers. NEVER strings.
2. Do not emit a circuit or season here — only the GP event. Circuits and seasons are extracted separately.
3. Do NOT invent events. Only extract those mentioned in the text.

## Output
{ "grandsPrix": [...] }`;

export function createExtractGrandsPrixNode(lookupStore: F1LookupStore) {
  return async function extractGrandsPrix(
    state: EnrichmentState,
  ): Promise<Partial<EnrichmentState>> {
    const decisions: DecisionLog[] = [];
    const now = new Date().toISOString();

    const result = await llmJsonCall({
      purpose: "extract_grands_prix",
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

    const grandsPrix: DraftGrandPrix[] = [];
    for (const gp of result.data.grandsPrix) {
      const aliases = Array.from(new Set([gp.name, ...gp.aliases]));
      const circuitId = await resolveCircuitId(
        gp.circuitName,
        state,
        lookupStore,
      );
      const seasonId = await resolveSeasonIdByYear(
        gp.seasonYear,
        state,
        lookupStore,
      );
      if (gp.circuitName && !circuitId) {
        decisions.push({
          level: "WARN",
          message: `grandPrix ${gp.name}: unresolved circuit "${gp.circuitName}"`,
          createdAtIso: now,
        });
      }
      if (gp.seasonYear !== undefined && !seasonId) {
        decisions.push({
          level: "WARN",
          message: `grandPrix ${gp.name}: unresolved season ${gp.seasonYear}`,
          createdAtIso: now,
        });
      }
      grandsPrix.push({
        entityId: nanoid(18),
        name: gp.name,
        aliases,
        aliasesLower: aliases.map((a) => a.toLowerCase()),
        circuitId,
        seasonId,
        date: gp.date,
        round: gp.round,
        isSprintWeekend: gp.isSprintWeekend,
      });
    }

    decisions.push({
      level: "INFO",
      message: `extractGrandsPrix: ${grandsPrix.length} grand prix event(s)`,
      createdAtIso: now,
    });

    return {
      grandsPrix,
      aiCalls: [result.aiCall],
      decisions,
    };
  };
}
