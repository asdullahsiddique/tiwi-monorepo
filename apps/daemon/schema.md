# Race Result Schema — Design Reference

## Context

Status: `apps/daemon/src/processors/processGrandPrixResultsV1.ts` now runs an
agent-driven extraction loop against `source.pdf`. The agent follows
`apps/daemon/SKILL.md`, writes `rounds.json`, and the daemon validates the file
as `RoundResult[]` before replacing the file's existing round documents in
MongoDB. `packages/mongodb/src/repositories/gpResultRepo.ts` stores one document
per extracted round, so one uploaded almanacco PDF can produce many
`gp_race_results` records under the same `{ orgId, fileId }`.

The original schema was designed for single-class, single-race events (Formula 1 style). Ferrari Challenge has two structural differences that required the schema to grow:

| Property | F1-style | Ferrari Challenge |
|---|---|---|
| Classes/categories per round | 1 | 4–5 (TROFEO PIRELLI, TROFEO PIRELLI AM, COPPA SHELL, COPPA SHELL AM, TROFEO PIRELLI MID) |
| Races per category per round | 1 | 2 (Race 1 + Race 2) |
| Pole Position / Fastest Lap | top-level | per race, per category |
| Car field | present | not relevant (spec series) |
| Points field | present | not in source data |

Rather than maintaining two completely separate schemas, the solution uses a **discriminated union** on a `type` field. This lets a single `RoundResultSchema` handle both formats while keeping TypeScript types narrow and inference clean.

---

## Shared primitives (unchanged)

```ts
const nullableOptionalString = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);

const nullableOptionalNumber = z
  .number()
  .nullish()
  .transform((value) => value ?? undefined);

const nullableOptionalPosition = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((value) => value ?? undefined);
```

---

## New building blocks

```ts
// Who set pole / fastest lap for a given race
const PoleOrFastestLapSchema = z.object({
  driver: nullableOptionalString,
  team: nullableOptionalString,
  time: nullableOptionalString,
});

// One driver's result row — shared across both formats.
// car + points are optional so they can be omitted for spec/challenge series
// while remaining available for F1-style events.
const ResultEntrySchema = z.object({
  position: nullableOptionalPosition,
  driver: z.string().min(1),
  team: z.string().min(1),
  car: nullableOptionalString,       // optional — not present in Ferrari Challenge
  timeOrGap: nullableOptionalString,
  points: nullableOptionalNumber,    // optional — not present in Ferrari Challenge
});
```

---

## Format A — single-class, single-race (F1-style)

Identical to the original schema, with `type: "single"` added as a discriminant and `car`/`points` made optional on the entry level (they were already `nullish` so this is non-breaking).

```ts
const GpSingleRaceResultSchema = z.object({
  type: z.literal("single"),
  grandPrix: z.string().min(1),
  circuit: z.string().min(1),
  country: nullableOptionalString,
  dateStart: nullableOptionalString,
  dateEnd: nullableOptionalString,
  polePosition: PoleOrFastestLapSchema.optional(),
  fastestLap: PoleOrFastestLapSchema.optional(),
  results: z.array(ResultEntrySchema),
});
```

### Why the change is non-breaking

- `type` is the only new required field. Existing records can be migrated with a one-liner:
  `record => ({ type: "single", ...record })`
- `car` and `points` were already `nullish()` so removing them from Ferrari Challenge data
  has no effect on F1 data.
- `polePosition` and `fastestLap` were missing from the original schema but are optional
  here, so existing data that omits them still validates.

---

## Format B — multi-class, multi-race (Ferrari Challenge style)

```ts
// One race within a category (e.g. TROFEO PIRELLI — Race 1)
const RaceSchema = z.object({
  raceNumber: z.number().int().min(1),      // 1 or 2
  polePosition: PoleOrFastestLapSchema.optional(),
  fastestLap: PoleOrFastestLapSchema.optional(),
  results: z.array(ResultEntrySchema),
});

// One category within a round (e.g. all TROFEO PIRELLI results)
const CategorySchema = z.object({
  name: z.enum([
    "TROFEO PIRELLI",
    "TROFEO PIRELLI AM",
    "COPPA SHELL",
    "COPPA SHELL AM",
    "TROFEO PIRELLI MID",   // Japan + Australasia only
  ]),
  races: z.array(RaceSchema),
});

const MultiClassRoundResultSchema = z.object({
  type: z.literal("multi-class"),
  championship: z.string().min(1),          // "Ferrari Challenge Europe", "North America", etc.
  grandPrix: z.string().min(1),             // venue name: "Monza", "Daytona", etc.
  circuit: z.string().min(1),
  country: nullableOptionalString,
  dateStart: nullableOptionalString,
  dateEnd: nullableOptionalString,
  round: nullableOptionalNumber,            // 1
  totalRounds: nullableOptionalNumber,      // 8
  categories: z.array(CategorySchema),
});
```

### Why each field was added

| Field | Reason |
|---|---|
| `type: "multi-class"` | Discriminant for the union — allows TypeScript to narrow the type |
| `championship` | Needed because the almanacco covers 6 separate championships in one document |
| `round` / `totalRounds` | Present in round headers ("Round 01/08") — useful for sorting and display |
| `categories` | The core structural addition. Each category runs independently with its own grid, its own races, its own pole and fastest lap |
| `polePosition` / `fastestLap` moved inside `RaceSchema` | In Ferrari Challenge these are per-race, per-category — not round-level |

---

## Unified entry point

```ts
const RoundResultSchema = z.discriminatedUnion("type", [
  GpSingleRaceResultSchema,
  MultiClassRoundResultSchema,
]);

type RoundResult = z.infer<typeof RoundResultSchema>;
```

Usage:

```ts
// Narrowing works automatically
if (result.type === "single") {
  result.results;      // ResultEntrySchema[]
} else {
  result.categories;   // CategorySchema[]
  result.championship; // string
}
```

---

## Example — Ferrari Challenge Europe, Monza Round 1

```json
{
  "type": "multi-class",
  "championship": "Ferrari Challenge Europe",
  "grandPrix": "Monza",
  "circuit": "Autodromo Nazionale Monza",
  "country": "Italy",
  "dateStart": "2025-03-27",
  "dateEnd": "2025-03-30",
  "round": 1,
  "totalRounds": 8,
  "categories": [
    {
      "name": "TROFEO PIRELLI",
      "races": [
        {
          "raceNumber": 1,
          "polePosition": {
            "driver": "Hauger",
            "team": "Ineos – Reparto Corse RAW",
            "time": "1:44.607"
          },
          "fastestLap": {
            "driver": "Hauger",
            "team": "Ineos – Reparto Corse RAW",
            "time": "1:44.607"
          },
          "results": [
            { "position": 1, "driver": "Calautti", "team": "Rossocorsa", "timeOrGap": null },
            { "position": 2, "driver": "Hauger", "team": "Ineos – Reparto Corse RAW", "timeOrGap": "22:40.575" },
            { "position": 3, "driver": "Sciaretta", "team": "Rallion Automotive", "timeOrGap": "32:13.635" }
          ]
        },
        {
          "raceNumber": 2,
          "polePosition": {
            "driver": "Massaia",
            "team": "Reparto Corse RAW",
            "time": null
          },
          "fastestLap": {
            "driver": "Hauger",
            "team": "Ineos – Reparto Corse RAW",
            "time": "1:44.425"
          },
          "results": [
            { "position": 1, "driver": "Ferri", "team": "Grid Fray Racing", "timeOrGap": "32:01.394" },
            { "position": 2, "driver": "Sciaretta", "team": "Rallion Automotive", "timeOrGap": "32:05.715" },
            { "position": 3, "driver": "Watkinson", "team": "—", "timeOrGap": null }
          ]
        }
      ]
    }
  ]
}
```
