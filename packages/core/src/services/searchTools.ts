import type OpenAI from "openai";
import {
  F1Repository,
  EmbeddingRepository,
  getMongoDb,
  type SimilarChunk,
} from "@tiwi/mongodb";

type Db = Awaited<ReturnType<typeof getMongoDb>>;

/**
 * Tool registry for the F1 semantic search LLM loop.
 *
 * Every tool:
 *   - Is exposed to OpenAI via `toolDefinitions` (JSON-schema shape the
 *     chat.completions API expects under `tools`).
 *   - Is implemented in `executeTool` below, which dispatches by tool name and
 *     returns a small JSON-serializable payload.
 *
 * All tool handlers scope queries by `orgId` internally — the LLM never sees
 * (or controls) the tenant.
 *
 * Design principles:
 *   - Tools that take entity names accept human-readable strings (e.g.
 *     "Max Verstappen", "Red Bull", 2023) and resolve them via the
 *     `F1Repository` alias-aware lookups. The LLM never needs to know
 *     internal entityIds.
 *   - Every list tool caps its `limit` server-side (max 100) to bound
 *     tokens regardless of what the LLM asks for.
 *   - `search_document_chunks` is just another tool; the LLM decides when
 *     unstructured retrieval is the right move.
 */

// ---------------------------------------------------------------------------
// Tool definitions (passed to OpenAI chat.completions as `tools`)
// ---------------------------------------------------------------------------

export const toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  // -------------------- Lookups --------------------
  {
    type: "function",
    function: {
      name: "lookup_driver",
      description:
        "Resolve a driver by name or alias. Use this first when you need a driver's entityId, or to confirm a driver exists in the org's dataset.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: 'Driver name or alias, e.g. "Max Verstappen", "VER", "Hamilton".',
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_constructor",
      description:
        "Resolve an F1 constructor (team) by name or alias. Use this to confirm a team exists in the dataset.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: 'Constructor name or alias, e.g. "Red Bull", "Ferrari", "Mercedes".',
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_grand_prix",
      description: "Resolve a grand prix by name or alias.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: 'Grand prix name or alias, e.g. "Monaco", "Italian GP", "Silverstone".',
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_season",
      description:
        "Resolve a season by year (preferred) or by name/alias. Use year when the query mentions a year.",
      parameters: {
        type: "object",
        properties: {
          year: {
            type: "integer",
            description: "Four-digit year, e.g. 2023.",
          },
          name: {
            type: "string",
            description: "Alternative: the season's stored name (rare).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_circuit",
      description: "Resolve a circuit by name or alias.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: 'Circuit name or alias, e.g. "Monza", "Spa-Francorchamps".',
          },
        },
        required: ["name"],
      },
    },
  },

  // -------------------- Deterministic stats --------------------
  {
    type: "function",
    function: {
      name: "count_metric",
      description:
        "Count a specific discrete metric across the dataset. Filter by any combination of driver, constructor, season. Use this for questions like 'How many wins did Hamilton get in 2023?'.",
      parameters: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: ["wins", "podiums", "poles", "fastestLaps", "dnfs"],
          },
          driverName: { type: "string" },
          constructorName: { type: "string" },
          seasonYear: { type: "integer" },
        },
        required: ["metric"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sum_points",
      description:
        "Sum championship points across race results matching the filters. Use for 'How many points did Red Bull get in 2024?'.",
      parameters: {
        type: "object",
        properties: {
          driverName: { type: "string" },
          constructorName: { type: "string" },
          seasonYear: { type: "integer" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "avg_pit_stop_ms",
      description:
        "Compute the average pit-stop duration in milliseconds for the given filters.",
      parameters: {
        type: "object",
        properties: {
          constructorName: { type: "string" },
          grandPrixName: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "driver_season_stats",
      description:
        "Return a driver's full season breakdown: wins, podiums, poles, fastest laps, DNFs, points.",
      parameters: {
        type: "object",
        properties: {
          driverName: { type: "string" },
          seasonYear: { type: "integer" },
        },
        required: ["driverName", "seasonYear"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "constructor_season_stats",
      description:
        "Return a constructor's full season breakdown: wins, podiums, DNFs, points.",
      parameters: {
        type: "object",
        properties: {
          constructorName: { type: "string" },
          seasonYear: { type: "integer" },
        },
        required: ["constructorName", "seasonYear"],
      },
    },
  },

  // -------------------- Structured lists --------------------
  {
    type: "function",
    function: {
      name: "list_race_results",
      description:
        "List race result rows scoped by any combination of driver / constructor / season / grand prix. Returns position, points, grid, status, times. Default limit 20, max 100.",
      parameters: {
        type: "object",
        properties: {
          driverName: { type: "string" },
          constructorName: { type: "string" },
          seasonYear: { type: "integer" },
          grandPrixName: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_qualifying_results",
      description:
        "List qualifying result rows (Q1/Q2/Q3 times in ms, final grid position). Filter by driver / constructor / season / grand prix.",
      parameters: {
        type: "object",
        properties: {
          driverName: { type: "string" },
          constructorName: { type: "string" },
          seasonYear: { type: "integer" },
          grandPrixName: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_sprint_results",
      description: "List sprint race result rows.",
      parameters: {
        type: "object",
        properties: {
          driverName: { type: "string" },
          constructorName: { type: "string" },
          seasonYear: { type: "integer" },
          grandPrixName: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_pit_stops",
      description:
        "List individual pit stops (duration in ms, lap, stop number). Filter by driver / constructor / grand prix.",
      parameters: {
        type: "object",
        properties: {
          driverName: { type: "string" },
          constructorName: { type: "string" },
          grandPrixName: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_incidents",
      description:
        "List on-track incidents (collisions, spins, mechanical failures) with optional filters. Driver is matched against the incident's driver list.",
      parameters: {
        type: "object",
        properties: {
          driverName: { type: "string" },
          seasonYear: { type: "integer" },
          grandPrixName: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_penalties",
      description:
        "List stewards' penalties (time penalties, grid drops, disqualifications, fines).",
      parameters: {
        type: "object",
        properties: {
          recipientName: {
            type: "string",
            description:
              "Driver or constructor name. Resolved against both pools.",
          },
          seasonYear: { type: "integer" },
          grandPrixName: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },

  // -------------------- Unstructured retrieval --------------------
  {
    type: "function",
    function: {
      name: "search_document_chunks",
      description:
        "Semantic search over indexed document chunks. Use when the question is narrative, qualitative, or asks for quotes / descriptions that won't be in structured collections. Returns top-k chunks with fileId, chunkId, score, text.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Natural-language query to embed for similarity search.",
          },
          topK: { type: "integer", minimum: 1, maximum: 20, default: 8 },
        },
        required: ["query"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export type ToolExecutionContext = {
  orgId: string;
  db: Db;
  openai: OpenAI;
  embeddingModel: string;
  /** Chunks collected across all `search_document_chunks` calls (for citations). */
  collectedChunks: SimilarChunk[];
};

type ToolResult =
  | Record<string, unknown>
  | Array<Record<string, unknown>>
  | { error: string };

export async function executeTool(
  name: string,
  rawArgs: string,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch (err) {
    return { error: `invalid_json_args: ${String(err)}` };
  }

  const f1 = new F1Repository(ctx.db);
  const embeddings = new EmbeddingRepository(ctx.db);
  const orgId = ctx.orgId;

  const resolveDriverId = async (name?: unknown): Promise<string | undefined> => {
    if (typeof name !== "string" || !name) return undefined;
    const hit = await f1.findDriverByNameOrAlias({ orgId, name });
    return hit?.entityId;
  };
  const resolveConstructorId = async (name?: unknown): Promise<string | undefined> => {
    if (typeof name !== "string" || !name) return undefined;
    const hit = await f1.findConstructorByNameOrAlias({ orgId, name });
    return hit?.entityId;
  };
  const resolveSeasonId = async (year?: unknown): Promise<string | undefined> => {
    if (typeof year !== "number") return undefined;
    const hit = await f1.findSeasonByYear({ orgId, year });
    return hit?.entityId;
  };
  const resolveGrandPrixId = async (name?: unknown): Promise<string | undefined> => {
    if (typeof name !== "string" || !name) return undefined;
    const hit = await f1.findGrandPrixByNameOrAlias({ orgId, name });
    return hit?.entityId;
  };

  switch (name) {
    // -------------------- Lookups --------------------
    case "lookup_driver": {
      const n = args.name;
      if (typeof n !== "string") return { error: "name_required" };
      const hit = await f1.findDriverByNameOrAlias({ orgId, name: n });
      if (!hit) return { found: false };
      return {
        found: true,
        entityId: hit.entityId,
        name: hit.name,
        aliases: hit.aliases,
        nationality: hit.nationality,
        number: hit.number,
        sourceFileIds: hit.sourceFileIds,
      };
    }
    case "lookup_constructor": {
      const n = args.name;
      if (typeof n !== "string") return { error: "name_required" };
      const hit = await f1.findConstructorByNameOrAlias({ orgId, name: n });
      if (!hit) return { found: false };
      return {
        found: true,
        entityId: hit.entityId,
        name: hit.name,
        aliases: hit.aliases,
        base: hit.base,
        powerUnit: hit.powerUnit,
        sourceFileIds: hit.sourceFileIds,
      };
    }
    case "lookup_grand_prix": {
      const n = args.name;
      if (typeof n !== "string") return { error: "name_required" };
      const hit = await f1.findGrandPrixByNameOrAlias({ orgId, name: n });
      if (!hit) return { found: false };
      return {
        found: true,
        entityId: hit.entityId,
        name: hit.name,
        aliases: hit.aliases,
        seasonId: hit.seasonId,
        circuitId: hit.circuitId,
        date: hit.date,
        round: hit.round,
      };
    }
    case "lookup_season": {
      if (typeof args.year === "number") {
        const hit = await f1.findSeasonByYear({ orgId, year: args.year });
        if (!hit) return { found: false };
        return {
          found: true,
          entityId: hit.entityId,
          name: hit.name,
          year: hit.year,
        };
      }
      if (typeof args.name === "string") {
        const hit = await f1.findSeasonByNameOrAlias({
          orgId,
          name: args.name,
        });
        if (!hit) return { found: false };
        return {
          found: true,
          entityId: hit.entityId,
          name: hit.name,
          year: hit.year,
        };
      }
      return { error: "year_or_name_required" };
    }
    case "lookup_circuit": {
      const n = args.name;
      if (typeof n !== "string") return { error: "name_required" };
      const hit = await f1.findCircuitByNameOrAlias({ orgId, name: n });
      if (!hit) return { found: false };
      return {
        found: true,
        entityId: hit.entityId,
        name: hit.name,
        aliases: hit.aliases,
        country: hit.country,
        city: hit.city,
        lapLengthKm: hit.lapLengthKm,
        numberOfLaps: hit.numberOfLaps,
      };
    }

    // -------------------- Stats --------------------
    case "count_metric": {
      const metric = args.metric;
      if (
        metric !== "wins" &&
        metric !== "podiums" &&
        metric !== "poles" &&
        metric !== "fastestLaps" &&
        metric !== "dnfs"
      ) {
        return { error: "invalid_metric" };
      }
      const driverId = await resolveDriverId(args.driverName);
      const constructorId = await resolveConstructorId(args.constructorName);
      const seasonId = await resolveSeasonId(args.seasonYear);
      const scope = { orgId, driverId, constructorId, seasonId };
      let value = 0;
      if (metric === "wins") value = await f1.countWins(scope);
      else if (metric === "podiums") value = await f1.countPodiums(scope);
      else if (metric === "poles") value = await f1.countPoles(scope);
      else if (metric === "fastestLaps") value = await f1.countFastestLaps(scope);
      else if (metric === "dnfs") value = await f1.countDnfs(scope);
      return {
        metric,
        value,
        resolved: {
          driverId: driverId ?? null,
          constructorId: constructorId ?? null,
          seasonId: seasonId ?? null,
        },
      };
    }
    case "sum_points": {
      const driverId = await resolveDriverId(args.driverName);
      const constructorId = await resolveConstructorId(args.constructorName);
      const seasonId = await resolveSeasonId(args.seasonYear);
      const value = await f1.sumPoints({
        orgId,
        driverId,
        constructorId,
        seasonId,
      });
      return {
        value,
        resolved: {
          driverId: driverId ?? null,
          constructorId: constructorId ?? null,
          seasonId: seasonId ?? null,
        },
      };
    }
    case "avg_pit_stop_ms": {
      const constructorId = await resolveConstructorId(args.constructorName);
      const grandPrixId = await resolveGrandPrixId(args.grandPrixName);
      const value = await f1.avgPitStopMs({
        orgId,
        constructorId,
        grandPrixId,
      });
      return {
        value,
        resolved: {
          constructorId: constructorId ?? null,
          grandPrixId: grandPrixId ?? null,
        },
      };
    }
    case "driver_season_stats": {
      const driverId = await resolveDriverId(args.driverName);
      const seasonId = await resolveSeasonId(args.seasonYear);
      if (!driverId || !seasonId) {
        return {
          error: "missing_entities",
          resolved: {
            driverId: driverId ?? null,
            seasonId: seasonId ?? null,
          },
        };
      }
      const stats = await f1.driverSeasonStats({
        orgId,
        driverId,
        seasonId,
      });
      return { stats, resolved: { driverId, seasonId } };
    }
    case "constructor_season_stats": {
      const constructorId = await resolveConstructorId(args.constructorName);
      const seasonId = await resolveSeasonId(args.seasonYear);
      if (!constructorId || !seasonId) {
        return {
          error: "missing_entities",
          resolved: {
            constructorId: constructorId ?? null,
            seasonId: seasonId ?? null,
          },
        };
      }
      const stats = await f1.constructorSeasonStats({
        orgId,
        constructorId,
        seasonId,
      });
      return { stats, resolved: { constructorId, seasonId } };
    }

    // -------------------- Lists --------------------
    case "list_race_results": {
      const rows = await f1.listRaceResults({
        orgId,
        driverId: await resolveDriverId(args.driverName),
        constructorId: await resolveConstructorId(args.constructorName),
        seasonId: await resolveSeasonId(args.seasonYear),
        grandPrixId: await resolveGrandPrixId(args.grandPrixName),
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return rows.map(projectRaceResult);
    }
    case "list_qualifying_results": {
      const rows = await f1.listQualifyingResults({
        orgId,
        driverId: await resolveDriverId(args.driverName),
        constructorId: await resolveConstructorId(args.constructorName),
        seasonId: await resolveSeasonId(args.seasonYear),
        grandPrixId: await resolveGrandPrixId(args.grandPrixName),
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return rows.map(projectQualifyingResult);
    }
    case "list_sprint_results": {
      const rows = await f1.listSprintResults({
        orgId,
        driverId: await resolveDriverId(args.driverName),
        constructorId: await resolveConstructorId(args.constructorName),
        seasonId: await resolveSeasonId(args.seasonYear),
        grandPrixId: await resolveGrandPrixId(args.grandPrixName),
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return rows.map(projectSprintResult);
    }
    case "list_pit_stops": {
      const rows = await f1.listPitStops({
        orgId,
        driverId: await resolveDriverId(args.driverName),
        constructorId: await resolveConstructorId(args.constructorName),
        grandPrixId: await resolveGrandPrixId(args.grandPrixName),
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return rows.map(projectPitStop);
    }
    case "list_incidents": {
      const rows = await f1.listIncidents({
        orgId,
        driverId: await resolveDriverId(args.driverName),
        seasonId: await resolveSeasonId(args.seasonYear),
        grandPrixId: await resolveGrandPrixId(args.grandPrixName),
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return rows.map(projectIncident);
    }
    case "list_penalties": {
      // recipient can be driver or constructor — try both.
      let recipientId: string | undefined;
      if (typeof args.recipientName === "string") {
        recipientId =
          (await resolveDriverId(args.recipientName)) ??
          (await resolveConstructorId(args.recipientName));
      }
      const rows = await f1.listPenalties({
        orgId,
        recipientId,
        seasonId: await resolveSeasonId(args.seasonYear),
        grandPrixId: await resolveGrandPrixId(args.grandPrixName),
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return rows.map(projectPenalty);
    }

    // -------------------- Unstructured retrieval --------------------
    case "search_document_chunks": {
      const q = args.query;
      if (typeof q !== "string" || !q) return { error: "query_required" };
      const topK = typeof args.topK === "number" ? args.topK : 8;
      const embedding = await ctx.openai.embeddings.create({
        model: ctx.embeddingModel,
        input: q,
      });
      const vector = embedding.data[0]?.embedding ?? [];
      const chunks = await embeddings.querySimilarChunks({
        orgId,
        vector,
        topK: Math.min(Math.max(topK, 1), 20),
      });
      ctx.collectedChunks.push(...chunks);
      return chunks.map((c) => ({
        fileId: c.fileId,
        chunkId: c.chunkId,
        score: c.score,
        text: c.text.slice(0, 1200),
      }));
    }

    default:
      return { error: `unknown_tool:${name}` };
  }
}

// ---------------------------------------------------------------------------
// Compact projections for fact lists (trim unnecessary fields & provenance
// verbatim quotes that can explode token usage).
// ---------------------------------------------------------------------------

function baseProjection(d: {
  entityId: string;
  name: string;
  sourceFileIds: string[];
}): Record<string, unknown> {
  return {
    entityId: d.entityId,
    name: d.name,
    sourceFileIds: d.sourceFileIds,
  };
}

function projectRaceResult(
  d: import("@tiwi/mongodb").RaceResultDocument,
): Record<string, unknown> {
  return {
    ...baseProjection(d),
    driverId: d.driverId,
    constructorId: d.constructorId,
    grandPrixId: d.grandPrixId,
    seasonId: d.seasonId,
    position: d.position,
    points: d.points,
    gridPosition: d.gridPosition,
    laps: d.laps,
    status: d.status,
    raceTimeMs: d.raceTimeMs,
    gapToWinnerMs: d.gapToWinnerMs,
    fastestLapTimeMs: d.fastestLapTimeMs,
    hadFastestLap: d.hadFastestLap,
  };
}

function projectQualifyingResult(
  d: import("@tiwi/mongodb").QualifyingResultDocument,
): Record<string, unknown> {
  return {
    ...baseProjection(d),
    driverId: d.driverId,
    constructorId: d.constructorId,
    grandPrixId: d.grandPrixId,
    seasonId: d.seasonId,
    gridPosition: d.gridPosition,
    q1Ms: d.q1Ms,
    q2Ms: d.q2Ms,
    q3Ms: d.q3Ms,
    knockedOutIn: d.knockedOutIn,
  };
}

function projectSprintResult(
  d: import("@tiwi/mongodb").SprintResultDocument,
): Record<string, unknown> {
  return {
    ...baseProjection(d),
    driverId: d.driverId,
    constructorId: d.constructorId,
    grandPrixId: d.grandPrixId,
    seasonId: d.seasonId,
    position: d.position,
    points: d.points,
    gridPosition: d.gridPosition,
    status: d.status,
  };
}

function projectPitStop(
  d: import("@tiwi/mongodb").PitStopDocument,
): Record<string, unknown> {
  return {
    ...baseProjection(d),
    driverId: d.driverId,
    constructorId: d.constructorId,
    grandPrixId: d.grandPrixId,
    seasonId: d.seasonId,
    stopNumber: d.stopNumber,
    lap: d.lap,
    durationMs: d.durationMs,
    tyreCompoundFrom: d.tyreCompoundFrom,
    tyreCompoundTo: d.tyreCompoundTo,
  };
}

function projectIncident(
  d: import("@tiwi/mongodb").IncidentDocument,
): Record<string, unknown> {
  return {
    ...baseProjection(d),
    driverIds: d.driverIds,
    grandPrixId: d.grandPrixId,
    seasonId: d.seasonId,
    lap: d.lap,
    incidentType: d.incidentType,
    description: d.description,
    causedSafetyCar: d.causedSafetyCar,
    causedVirtualSafetyCar: d.causedVirtualSafetyCar,
    causedRedFlag: d.causedRedFlag,
  };
}

function projectPenalty(
  d: import("@tiwi/mongodb").PenaltyDocument,
): Record<string, unknown> {
  return {
    ...baseProjection(d),
    recipientId: d.recipientId,
    recipientType: d.recipientType,
    grandPrixId: d.grandPrixId,
    seasonId: d.seasonId,
    penaltyType: d.penaltyType,
    value: d.value,
    unit: d.unit,
    reason: d.reason,
    relatedIncidentId: d.relatedIncidentId,
  };
}
