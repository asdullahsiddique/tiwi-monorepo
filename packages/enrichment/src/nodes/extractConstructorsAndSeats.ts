import { z } from "zod";
import { nanoid } from "nanoid";
import type { EnrichmentState } from "../state";
import type {
  DecisionLog,
  DraftConstructor,
  DraftDriverSeat,
  DraftTeamPrincipal,
} from "../types";
import type { F1LookupStore } from "../f1LookupStore";
import { llmJsonCall } from "../util/llm";
import { resolveConstructorId, resolveDriverId } from "../util/resolve";

const ExtractionSchema = z.object({
  constructors: z
    .array(
      z.object({
        name: z.string().min(1),
        aliases: z.array(z.string()).default([]),
        base: z.string().optional(),
        powerUnit: z.string().optional(),
      }),
    )
    .default([]),
  teamPrincipals: z
    .array(
      z.object({
        name: z.string().min(1),
        aliases: z.array(z.string()).default([]),
        constructorName: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
      }),
    )
    .default([]),
  driverSeats: z
    .array(
      z.object({
        driverName: z.string().min(1),
        constructorName: z.string().min(1),
        seasonYear: z.number().int().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        isReserveOrTest: z.boolean().optional(),
      }),
    )
    .default([]),
});

const SYSTEM_PROMPT = `You are an expert F1 data extractor. Extract CONSTRUCTORS (teams), their TEAM PRINCIPALS, and DRIVER SEATS (driver × constructor memberships) from the text.

## Schemas

### constructor
- name: canonical team name (e.g. "Red Bull Racing", "Mercedes").
- aliases: other forms used in the text ("Red Bull", "RBR", "Merc", "Scuderia Ferrari"). Include the canonical name too.
- base: headquarters location (e.g. "Milton Keynes, UK") — optional.
- powerUnit: engine supplier (e.g. "Honda RBPT", "Mercedes") — optional.

### teamPrincipal
- name: canonical full name (e.g. "Toto Wolff").
- aliases: other variants used in the text.
- constructorName: the team they lead (string — will be resolved to ID later).
- startDate / endDate: optional ISO dates.

### driverSeat (for each "driver is racing for team X in season Y")
- driverName: the driver's name (any form mentioned in the text).
- constructorName: the constructor's name (any form).
- seasonYear: JSON number (e.g. 2024). Do NOT emit a string.
- startDate / endDate: optional ISO dates.
- isReserveOrTest: true if they are a reserve/test driver only.

## Rules
1. Do not confuse drivers with team principals. Principals do NOT drive the car.
2. Output driverSeats ONLY if the text explicitly says driver X drives/drove for team Y (optionally in season Z).
3. "seasonYear" MUST be a JSON number.
4. Do NOT invent entities. Only extract those mentioned.

## Output
{ "constructors": [...], "teamPrincipals": [...], "driverSeats": [...] }`;

export function createExtractConstructorsAndSeatsNode(
  lookupStore: F1LookupStore,
) {
  return async function extractConstructorsAndSeats(
    state: EnrichmentState,
  ): Promise<Partial<EnrichmentState>> {
    const decisions: DecisionLog[] = [];
    const now = new Date().toISOString();

    const result = await llmJsonCall({
      purpose: "extract_constructors_and_seats",
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

    const constructors: DraftConstructor[] = result.data.constructors.map(
      (c) => {
        const aliases = Array.from(new Set([c.name, ...c.aliases]));
        return {
          entityId: nanoid(18),
          name: c.name,
          aliases,
          aliasesLower: aliases.map((a) => a.toLowerCase()),
          base: c.base,
          powerUnit: c.powerUnit,
        };
      },
    );

    // Build a preview state so resolve* can see constructors we just extracted.
    const previewState: EnrichmentState = { ...state, constructors: [...state.constructors, ...constructors] };

    const teamPrincipals: DraftTeamPrincipal[] = [];
    for (const tp of result.data.teamPrincipals) {
      const aliases = Array.from(new Set([tp.name, ...tp.aliases]));
      const constructorId = await resolveConstructorId(
        tp.constructorName,
        previewState,
        lookupStore,
      );
      if (tp.constructorName && !constructorId) {
        decisions.push({
          level: "WARN",
          message: `teamPrincipal ${tp.name}: unresolved constructor "${tp.constructorName}"`,
          createdAtIso: now,
        });
      }
      teamPrincipals.push({
        entityId: nanoid(18),
        name: tp.name,
        aliases,
        aliasesLower: aliases.map((a) => a.toLowerCase()),
        constructorId,
        startDate: tp.startDate,
        endDate: tp.endDate,
      });
    }

    const driverSeats: DraftDriverSeat[] = [];
    for (const seat of result.data.driverSeats) {
      const driverId = await resolveDriverId(
        seat.driverName,
        previewState,
        lookupStore,
      );
      const constructorId = await resolveConstructorId(
        seat.constructorName,
        previewState,
        lookupStore,
      );
      if (!driverId) {
        decisions.push({
          level: "WARN",
          message: `driverSeat: unresolved driver "${seat.driverName}" (skipping)`,
          createdAtIso: now,
        });
        continue;
      }
      if (!constructorId) {
        decisions.push({
          level: "WARN",
          message: `driverSeat: unresolved constructor "${seat.constructorName}" (skipping)`,
          createdAtIso: now,
        });
        continue;
      }
      driverSeats.push({
        entityId: nanoid(18),
        name: `${seat.driverName} @ ${seat.constructorName}${seat.seasonYear ? ` (${seat.seasonYear})` : ""}`,
        driverId,
        constructorId,
        seasonId: undefined,
        startDate: seat.startDate,
        endDate: seat.endDate,
        isReserveOrTest: seat.isReserveOrTest,
      });
    }

    decisions.push({
      level: "INFO",
      message: `extractConstructorsAndSeats: ${constructors.length} constructors, ${teamPrincipals.length} principals, ${driverSeats.length} seats`,
      createdAtIso: now,
    });

    return {
      constructors,
      teamPrincipals,
      driverSeats,
      aiCalls: [result.aiCall],
      decisions,
    };
  };
}
