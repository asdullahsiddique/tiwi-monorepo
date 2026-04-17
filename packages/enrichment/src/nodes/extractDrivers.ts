import { z } from "zod";
import { nanoid } from "nanoid";
import type { EnrichmentState } from "../state";
import type { DecisionLog, DraftDriver } from "../types";
import type { F1LookupStore } from "../f1LookupStore";
import { llmJsonCall } from "../util/llm";

const DriverExtractionSchema = z.object({
  drivers: z
    .array(
      z.object({
        name: z.string().min(1),
        aliases: z.array(z.string()).default([]),
        nationality: z.string().optional(),
        number: z.number().int().positive().optional(),
        dateOfBirth: z.string().optional(),
      }),
    )
    .default([]),
});

const SYSTEM_PROMPT = `You are an expert F1 data extractor. Extract every Formula 1 DRIVER mentioned in the text.

## Schema — driver
- name: canonical full name (e.g. "Max Verstappen", "Lewis Hamilton").
- aliases: every other form used in the text (nicknames, surname-only, 3-letter codes, car numbers). Example for Max Verstappen: ["Max", "VER", "Verstappen", "#1"]. Include the canonical name too.
- nationality: optional (e.g. "Dutch", "British").
- number: optional — permanent driver number as a JSON NUMBER, not a string. e.g. 1, 44, 16.
- dateOfBirth: optional ISO date string.

## Rules
1. Only extract humans who DRIVE the car. Skip team principals, engineers, reporters, and officials.
2. "number" MUST be a JSON number if provided. NEVER a string. Skip the field if you aren't sure.
3. Include the canonical name in \`aliases\` as well, plus every variant that appears.
4. Do NOT invent drivers. Only extract drivers actually mentioned in the text.

## Output
Return a JSON object: { "drivers": [ { "name": "...", "aliases": [...], "nationality": "...", "number": 1, "dateOfBirth": "..." } ] }`;

export function createExtractDriversNode(_lookupStore: F1LookupStore) {
  return async function extractDrivers(
    state: EnrichmentState,
  ): Promise<Partial<EnrichmentState>> {
    const decisions: DecisionLog[] = [];
    const now = new Date().toISOString();

    const result = await llmJsonCall({
      purpose: "extract_drivers",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `TEXT:\n${state.text}`,
      schema: DriverExtractionSchema,
    });

    decisions.push(...result.decisions);

    if (!result.ok) {
      return {
        decisions,
        errors: [result.error],
        aiCalls: result.aiCall ? [result.aiCall] : [],
      };
    }

    const drivers: DraftDriver[] = result.data.drivers.map((d) => {
      const aliases = Array.from(new Set([d.name, ...d.aliases]));
      return {
        entityId: nanoid(18),
        name: d.name,
        aliases,
        aliasesLower: aliases.map((a) => a.toLowerCase()),
        nationality: d.nationality,
        number: d.number,
        dateOfBirth: d.dateOfBirth,
      };
    });

    decisions.push({
      level: "INFO",
      message: `extractDrivers: extracted ${drivers.length} driver(s)`,
      createdAtIso: now,
      metadata: { names: drivers.slice(0, 20).map((d) => d.name) },
    });

    return {
      drivers,
      aiCalls: [result.aiCall],
      decisions,
    };
  };
}
