import { z } from "zod";
import { nanoid } from "nanoid";
import type { EnrichmentState } from "../state";
import type { DecisionLog, DraftCircuit, DraftSeason } from "../types";
import type { F1LookupStore } from "../f1LookupStore";
import { llmJsonCall } from "../util/llm";

const ExtractionSchema = z.object({
  circuits: z
    .array(
      z.object({
        name: z.string().min(1),
        aliases: z.array(z.string()).default([]),
        country: z.string().optional(),
        city: z.string().optional(),
        lapLengthKm: z.number().optional(),
        numberOfLaps: z.number().int().optional(),
      }),
    )
    .default([]),
  seasons: z
    .array(
      z.object({
        year: z.number().int(),
        aliases: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

const SYSTEM_PROMPT = `You are an expert F1 data extractor. Extract CIRCUITS (tracks) and SEASONS (years) mentioned in the text.

## circuit
- name: canonical circuit name (e.g. "Circuit de Monaco", "Silverstone Circuit").
- aliases: other names used ("Monaco GP track", "Silverstone"). Include the canonical name too.
- country / city: optional strings.
- lapLengthKm: JSON number in kilometers (e.g. 3.337).
- numberOfLaps: JSON integer (e.g. 78).

## season
- year: JSON integer (e.g. 2024). NOT a string.
- aliases: text forms like "2024 season", "24 season".

## Rules
1. "lapLengthKm", "numberOfLaps", and "year" MUST be JSON numbers. NEVER strings.
2. Do not confuse a Grand Prix (the race event) with a Circuit (the physical track) — skip GP names here, they are extracted separately.
3. Do NOT invent circuits or seasons.

## Output
{ "circuits": [...], "seasons": [...] }`;

export function createExtractCircuitsAndSeasonsNode(
  _lookupStore: F1LookupStore,
) {
  return async function extractCircuitsAndSeasons(
    state: EnrichmentState,
  ): Promise<Partial<EnrichmentState>> {
    const decisions: DecisionLog[] = [];
    const now = new Date().toISOString();

    const result = await llmJsonCall({
      purpose: "extract_circuits_and_seasons",
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

    const circuits: DraftCircuit[] = result.data.circuits.map((c) => {
      const aliases = Array.from(new Set([c.name, ...c.aliases]));
      return {
        entityId: nanoid(18),
        name: c.name,
        aliases,
        aliasesLower: aliases.map((a) => a.toLowerCase()),
        country: c.country,
        city: c.city,
        lapLengthKm: c.lapLengthKm,
        numberOfLaps: c.numberOfLaps,
      };
    });

    const seasons: DraftSeason[] = result.data.seasons.map((s) => {
      const canonical = String(s.year);
      const aliases = Array.from(new Set([canonical, ...s.aliases]));
      return {
        entityId: nanoid(18),
        name: canonical,
        aliases,
        aliasesLower: aliases.map((a) => a.toLowerCase()),
        year: s.year,
      };
    });

    decisions.push({
      level: "INFO",
      message: `extractCircuitsAndSeasons: ${circuits.length} circuits, ${seasons.length} seasons`,
      createdAtIso: now,
    });

    return {
      circuits,
      seasons,
      aiCalls: [result.aiCall],
      decisions,
    };
  };
}
