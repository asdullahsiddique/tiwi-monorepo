import { z } from "zod";
import { nanoid } from "nanoid";
import type { EnrichmentState } from "../state";
import type {
  DecisionLog,
  DraftCar,
  DraftQuote,
  DraftTransferRumour,
  DraftTyreCompound,
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

const CarSchema = z.object({
  constructorName: z.string().optional(),
  seasonYear: z.number().int().optional(),
  designation: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.8),
  sourceSpan: z.string().optional(),
});

const TyreCompoundSchema = z.object({
  compound: z
    .enum(["Soft", "Medium", "Hard", "Intermediate", "Wet"])
    .optional(),
  supplier: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.8),
  sourceSpan: z.string().optional(),
});

const QuoteSchema = z.object({
  speakerName: z.string().optional(),
  speakerType: z
    .enum(["Driver", "TeamPrincipal", "Official", "Engineer", "Other"])
    .optional(),
  grandPrixName: z.string().optional(),
  context: z.string().optional(),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.8),
  sourceSpan: z.string().optional(),
});

const TransferRumourSchema = z.object({
  driverName: z.string().optional(),
  fromConstructorName: z.string().optional(),
  toConstructorName: z.string().optional(),
  targetSeasonYear: z.number().int().optional(),
  reportedDate: z.string().optional(),
  reportedStatus: z.enum(["Rumour", "Reported", "Confirmed"]).optional(),
  confidence: z.number().min(0).max(1).default(0.8),
  sourceSpan: z.string().optional(),
});

const ExtractionSchema = z.object({
  cars: z.array(CarSchema).default([]),
  tyreCompounds: z.array(TyreCompoundSchema).default([]),
  quotes: z.array(QuoteSchema).default([]),
  transferRumours: z.array(TransferRumourSchema).default([]),
});

const SYSTEM_PROMPT = `You are an expert F1 data extractor. Extract contextual/media entities: CARS, TYRE COMPOUNDS, QUOTES, and TRANSFER RUMOURS.

## car
- constructorName: the manufacturer.
- seasonYear: JSON integer.
- designation: model name (e.g. "RB20", "W15").

## tyreCompound
- compound: one of "Soft" | "Medium" | "Hard" | "Intermediate" | "Wet".
- supplier: tyre supplier name.

## quote — direct quotation attributed to a person
- speakerName: who said it.
- speakerType: "Driver" | "TeamPrincipal" | "Official" | "Engineer" | "Other".
- grandPrixName: context if the quote was in a GP context.
- context: e.g. "post-race interview", "pre-qualifying press conference".
- text: REQUIRED — the actual quoted words.

## transferRumour
- driverName: the driver the rumour is about.
- fromConstructorName, toConstructorName: the teams.
- targetSeasonYear: JSON integer — the season the move would take effect.
- reportedStatus: "Rumour" | "Reported" | "Confirmed".

## Rules
1. Only extract entities actually mentioned in the text.
2. All numeric fields MUST be JSON numbers.
3. A "quote" MUST have non-empty text.
4. Every record MUST include confidence (0..1) and a short sourceSpan.

## Output
{ "cars": [...], "tyreCompounds": [...], "quotes": [...], "transferRumours": [...] }`;

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

export function createExtractMediaEntitiesNode(lookupStore: F1LookupStore) {
  return async function extractMediaEntities(
    state: EnrichmentState,
  ): Promise<Partial<EnrichmentState>> {
    const decisions: DecisionLog[] = [];
    const now = new Date().toISOString();

    const result = await llmJsonCall({
      purpose: "extract_media_entities",
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

    const cars: DraftCar[] = [];
    for (const c of result.data.cars) {
      const constructorId = await resolveConstructorId(
        c.constructorName,
        state,
        lookupStore,
      );
      const seasonId = await resolveSeasonIdByYear(
        c.seasonYear,
        state,
        lookupStore,
      );
      cars.push({
        entityId: nanoid(18),
        name: c.designation ?? `${c.constructorName ?? "?"} ${c.seasonYear ?? "?"}`,
        provenance: [
          buildProvenance(
            state.fileId,
            state.sourceChunkIds,
            c.sourceSpan,
            c.confidence,
          ),
        ],
        constructorId,
        seasonId,
        designation: c.designation,
      });
    }

    const tyreCompounds: DraftTyreCompound[] = result.data.tyreCompounds.map(
      (t) => ({
        entityId: nanoid(18),
        name: t.compound ?? "TyreCompound",
        provenance: [
          buildProvenance(
            state.fileId,
            state.sourceChunkIds,
            t.sourceSpan,
            t.confidence,
          ),
        ],
        compound: t.compound,
        supplier: t.supplier,
      }),
    );

    const quotes: DraftQuote[] = [];
    for (const q of result.data.quotes) {
      let speakerId: string | undefined;
      if (q.speakerName) {
        if (q.speakerType === "Driver") {
          speakerId = await resolveDriverId(q.speakerName, state, lookupStore);
        } else {
          // TeamPrincipal / Engineer / Official: no dedicated lookup; leave undefined.
          speakerId = undefined;
        }
      }
      const grandPrixId = await resolveGrandPrixId(
        q.grandPrixName,
        state,
        lookupStore,
      );
      quotes.push({
        entityId: nanoid(18),
        name: `Quote: ${q.speakerName ?? "?"}`,
        provenance: [
          buildProvenance(
            state.fileId,
            state.sourceChunkIds,
            q.sourceSpan,
            q.confidence,
          ),
        ],
        speakerId,
        speakerType: q.speakerType,
        grandPrixId,
        context: q.context,
        text: q.text,
      });
    }

    const transferRumours: DraftTransferRumour[] = [];
    for (const r of result.data.transferRumours) {
      const driverId = await resolveDriverId(r.driverName, state, lookupStore);
      const fromConstructorId = await resolveConstructorId(
        r.fromConstructorName,
        state,
        lookupStore,
      );
      const toConstructorId = await resolveConstructorId(
        r.toConstructorName,
        state,
        lookupStore,
      );
      const targetSeasonId = await resolveSeasonIdByYear(
        r.targetSeasonYear,
        state,
        lookupStore,
      );
      transferRumours.push({
        entityId: nanoid(18),
        name:
          `${r.driverName ?? "?"} ${r.fromConstructorName ?? "?"} → ${r.toConstructorName ?? "?"}`,
        provenance: [
          buildProvenance(
            state.fileId,
            state.sourceChunkIds,
            r.sourceSpan,
            r.confidence,
          ),
        ],
        driverId,
        fromConstructorId,
        toConstructorId,
        targetSeasonId,
        reportedDate: r.reportedDate,
        reportedStatus: r.reportedStatus,
      });
    }

    decisions.push({
      level: "INFO",
      message: `extractMediaEntities: cars=${cars.length} tyres=${tyreCompounds.length} quotes=${quotes.length} rumours=${transferRumours.length}`,
      createdAtIso: now,
    });

    return {
      cars,
      tyreCompounds,
      quotes,
      transferRumours,
      aiCalls: [result.aiCall],
      decisions,
    };
  };
}
