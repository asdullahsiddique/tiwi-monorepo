import type { Db } from "mongodb";
import { nanoid } from "nanoid";
import {
  F1_COLL,
  type CarDocument,
  type CircuitDocument,
  type ConstructorDocument,
  type DriverDocument,
  type DriverSeatDocument,
  type F1BaseDocument,
  type F1CollectionName,
  type FactProvenance,
  type GrandPrixDocument,
  type IncidentDocument,
  type PenaltyDocument,
  type PitStopDocument,
  type QualifyingResultDocument,
  type QuoteDocument,
  type RaceResultDocument,
  type SeasonDocument,
  type SprintResultDocument,
  type TeamPrincipalDocument,
  type TransferRumourDocument,
  type TyreCompoundDocument,
} from "../f1Documents";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toIso(d: unknown): string {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string") return d;
  return "";
}

function newEntityId(): string {
  return nanoid(18);
}

function lower(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return values.map((v) => v.toLowerCase());
}

function uniq(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Input shape shared by every reference-entity upsert. Extra typed fields
 * (nationality, base, country, ...) are merged via the generic `extra`.
 */
type RefUpsertInput<T> = {
  orgId: string;
  sourceFileId: string;
  name: string;
  aliases?: string[];
  /** Pre-generated candidate entityId; only used if no existing doc matches. */
  entityId?: string;
  extra?: Partial<T>;
};

/**
 * Input shape shared by every fact/event upsert.
 * The caller must supply provenance; natural-key fields come via `doc`.
 */
type FactUpsertInput<T> = {
  orgId: string;
  sourceFileId: string;
  provenance: FactProvenance;
  entityId?: string;
  doc: Partial<T> & { name?: string };
};

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export type F1EntitiesByFile = {
  collection: F1CollectionName;
  docs: F1BaseDocument[];
};

export type F1EntitySummary = {
  entityId: string;
  collection: F1CollectionName;
  name: string;
  aliases?: string[];
  mentionCount: number;
};

export class F1Repository {
  constructor(private readonly db: Db) {}

  // -------------------------------------------------------------------------
  // Reference-entity upserts
  // -------------------------------------------------------------------------

  async upsertDriver(params: RefUpsertInput<DriverDocument>): Promise<string> {
    return this.upsertReference<DriverDocument>(F1_COLL.drivers, params);
  }

  async upsertConstructor(
    params: RefUpsertInput<ConstructorDocument>,
  ): Promise<string> {
    return this.upsertReference<ConstructorDocument>(
      F1_COLL.constructors,
      params,
    );
  }

  async upsertCircuit(
    params: RefUpsertInput<CircuitDocument>,
  ): Promise<string> {
    return this.upsertReference<CircuitDocument>(F1_COLL.circuits, params);
  }

  async upsertSeason(params: RefUpsertInput<SeasonDocument>): Promise<string> {
    return this.upsertReference<SeasonDocument>(F1_COLL.seasons, params);
  }

  async upsertGrandPrix(
    params: RefUpsertInput<GrandPrixDocument>,
  ): Promise<string> {
    return this.upsertReference<GrandPrixDocument>(F1_COLL.grandsPrix, params);
  }

  async upsertTeamPrincipal(
    params: RefUpsertInput<TeamPrincipalDocument>,
  ): Promise<string> {
    return this.upsertReference<TeamPrincipalDocument>(
      F1_COLL.teamPrincipals,
      params,
    );
  }

  /** DriverSeat is a non-reference, time-bounded entity. */
  async upsertDriverSeat(params: {
    orgId: string;
    sourceFileId: string;
    entityId?: string;
    driverId: string;
    constructorId: string;
    seasonId?: string;
    startDate?: string;
    endDate?: string;
    isReserveOrTest?: boolean;
    name?: string;
  }): Promise<string> {
    const now = new Date();
    const name =
      params.name ??
      [params.driverId, params.constructorId, params.seasonId ?? "any"].join(
        ":",
      );
    const nameLower = name.toLowerCase();
    const candidateId = params.entityId ?? newEntityId();

    const filter: Record<string, unknown> = {
      orgId: params.orgId,
      driverId: params.driverId,
      constructorId: params.constructorId,
      seasonId: params.seasonId ?? null,
    };

    const $set: Record<string, unknown> = {
      name,
      nameLower,
      updatedAt: now,
    };
    if (params.startDate !== undefined) $set.startDate = params.startDate;
    if (params.endDate !== undefined) $set.endDate = params.endDate;
    if (params.isReserveOrTest !== undefined)
      $set.isReserveOrTest = params.isReserveOrTest;

    const res = await this.db.collection(F1_COLL.driverSeats).findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          orgId: params.orgId,
          entityId: candidateId,
          driverId: params.driverId,
          constructorId: params.constructorId,
          seasonId: params.seasonId ?? null,
          createdAt: now,
        },
        $set,
        $addToSet: { sourceFileIds: params.sourceFileId },
      },
      { upsert: true, returnDocument: "after" },
    );

    return String((res as { entityId?: string } | null)?.entityId ?? candidateId);
  }

  // -------------------------------------------------------------------------
  // Fact/result upserts
  // -------------------------------------------------------------------------

  async upsertRaceResult(
    params: FactUpsertInput<RaceResultDocument>,
  ): Promise<string> {
    return this.upsertFact<RaceResultDocument>(F1_COLL.raceResults, params, [
      "driverId",
      "grandPrixId",
    ]);
  }

  async upsertQualifyingResult(
    params: FactUpsertInput<QualifyingResultDocument>,
  ): Promise<string> {
    return this.upsertFact<QualifyingResultDocument>(
      F1_COLL.qualifyingResults,
      params,
      ["driverId", "grandPrixId"],
    );
  }

  async upsertSprintResult(
    params: FactUpsertInput<SprintResultDocument>,
  ): Promise<string> {
    return this.upsertFact<SprintResultDocument>(
      F1_COLL.sprintResults,
      params,
      ["driverId", "grandPrixId"],
    );
  }

  async upsertPitStop(
    params: FactUpsertInput<PitStopDocument>,
  ): Promise<string> {
    return this.upsertFact<PitStopDocument>(F1_COLL.pitStops, params, [
      "driverId",
      "grandPrixId",
      "stopNumber",
    ]);
  }

  async upsertIncident(
    params: FactUpsertInput<IncidentDocument>,
  ): Promise<string> {
    return this.upsertFact<IncidentDocument>(F1_COLL.incidents, params, [
      "grandPrixId",
      "lap",
      "incidentType",
    ]);
  }

  async upsertPenalty(
    params: FactUpsertInput<PenaltyDocument>,
  ): Promise<string> {
    return this.upsertFact<PenaltyDocument>(F1_COLL.penalties, params, [
      "recipientId",
      "grandPrixId",
      "penaltyType",
    ]);
  }

  async upsertCar(params: FactUpsertInput<CarDocument>): Promise<string> {
    return this.upsertFact<CarDocument>(F1_COLL.cars, params, [
      "constructorId",
      "seasonId",
      "designation",
    ]);
  }

  async upsertTyreCompound(
    params: FactUpsertInput<TyreCompoundDocument>,
  ): Promise<string> {
    return this.upsertFact<TyreCompoundDocument>(
      F1_COLL.tyreCompounds,
      params,
      ["compound", "supplier"],
    );
  }

  async upsertQuote(params: FactUpsertInput<QuoteDocument>): Promise<string> {
    return this.upsertFact<QuoteDocument>(F1_COLL.quotes, params, [
      "speakerId",
      "grandPrixId",
      "text",
    ]);
  }

  async upsertTransferRumour(
    params: FactUpsertInput<TransferRumourDocument>,
  ): Promise<string> {
    return this.upsertFact<TransferRumourDocument>(
      F1_COLL.transferRumours,
      params,
      ["driverId", "toConstructorId", "targetSeasonId"],
    );
  }

  // -------------------------------------------------------------------------
  // Alias-aware lookups
  // -------------------------------------------------------------------------

  async findDriverByNameOrAlias(params: {
    orgId: string;
    name: string;
  }): Promise<DriverDocument | null> {
    return this.findReferenceByNameOrAlias<DriverDocument>(
      F1_COLL.drivers,
      params,
    );
  }

  async findConstructorByNameOrAlias(params: {
    orgId: string;
    name: string;
  }): Promise<ConstructorDocument | null> {
    return this.findReferenceByNameOrAlias<ConstructorDocument>(
      F1_COLL.constructors,
      params,
    );
  }

  async findCircuitByNameOrAlias(params: {
    orgId: string;
    name: string;
  }): Promise<CircuitDocument | null> {
    return this.findReferenceByNameOrAlias<CircuitDocument>(
      F1_COLL.circuits,
      params,
    );
  }

  async findGrandPrixByNameOrAlias(params: {
    orgId: string;
    name: string;
  }): Promise<GrandPrixDocument | null> {
    return this.findReferenceByNameOrAlias<GrandPrixDocument>(
      F1_COLL.grandsPrix,
      params,
    );
  }

  async findSeasonByYear(params: {
    orgId: string;
    year: number;
  }): Promise<SeasonDocument | null> {
    const doc = await this.db
      .collection(F1_COLL.seasons)
      .findOne({ orgId: params.orgId, year: params.year });
    return (doc as unknown as SeasonDocument) ?? null;
  }

  async findSeasonByNameOrAlias(params: {
    orgId: string;
    name: string;
  }): Promise<SeasonDocument | null> {
    return this.findReferenceByNameOrAlias<SeasonDocument>(
      F1_COLL.seasons,
      params,
    );
  }

  // -------------------------------------------------------------------------
  // File-view & summary
  // -------------------------------------------------------------------------

  async getEntitiesByFile(params: {
    orgId: string;
    fileId: string;
  }): Promise<F1EntitiesByFile[]> {
    const out: F1EntitiesByFile[] = [];
    for (const coll of Object.values(F1_COLL) as F1CollectionName[]) {
      const docs = await this.db
        .collection(coll)
        .find({ orgId: params.orgId, sourceFileIds: params.fileId })
        .sort({ name: 1 })
        .toArray();
      if (docs.length === 0) continue;
      out.push({
        collection: coll,
        docs: docs.map((d) => this.normalizeBase(d as Record<string, unknown>)),
      });
    }
    return out;
  }

  async getAllEntitiesSummary(params: {
    orgId: string;
    limit?: number;
  }): Promise<F1EntitySummary[]> {
    const limit = params.limit ?? 500;
    const rows: F1EntitySummary[] = [];
    for (const coll of Object.values(F1_COLL) as F1CollectionName[]) {
      const docs = await this.db
        .collection(coll)
        .find({ orgId: params.orgId })
        .project({
          entityId: 1,
          name: 1,
          aliases: 1,
          sourceFileIds: 1,
        })
        .toArray();
      for (const raw of docs) {
        const d = raw as {
          entityId: string;
          name: string;
          aliases?: string[];
          sourceFileIds?: string[];
        };
        rows.push({
          entityId: d.entityId,
          collection: coll,
          name: d.name,
          aliases: d.aliases,
          mentionCount: Array.isArray(d.sourceFileIds)
            ? d.sourceFileIds.length
            : 0,
        });
      }
    }
    rows.sort(
      (a, b) =>
        b.mentionCount - a.mentionCount || a.name.localeCompare(b.name),
    );
    return rows.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Quantitative aggregation helpers
  // -------------------------------------------------------------------------

  async countWins(params: {
    orgId: string;
    driverId?: string;
    constructorId?: string;
    seasonId?: string;
  }): Promise<number> {
    const filter: Record<string, unknown> = {
      orgId: params.orgId,
      position: 1,
    };
    if (params.driverId) filter.driverId = params.driverId;
    if (params.constructorId) filter.constructorId = params.constructorId;
    if (params.seasonId) filter.seasonId = params.seasonId;
    return this.db.collection(F1_COLL.raceResults).countDocuments(filter);
  }

  async countPodiums(params: {
    orgId: string;
    driverId?: string;
    constructorId?: string;
    seasonId?: string;
  }): Promise<number> {
    const filter: Record<string, unknown> = {
      orgId: params.orgId,
      position: { $in: [1, 2, 3] },
    };
    if (params.driverId) filter.driverId = params.driverId;
    if (params.constructorId) filter.constructorId = params.constructorId;
    if (params.seasonId) filter.seasonId = params.seasonId;
    return this.db.collection(F1_COLL.raceResults).countDocuments(filter);
  }

  async countPoles(params: {
    orgId: string;
    driverId?: string;
    constructorId?: string;
    seasonId?: string;
  }): Promise<number> {
    const filter: Record<string, unknown> = {
      orgId: params.orgId,
      gridPosition: 1,
    };
    if (params.driverId) filter.driverId = params.driverId;
    if (params.constructorId) filter.constructorId = params.constructorId;
    if (params.seasonId) filter.seasonId = params.seasonId;
    return this.db
      .collection(F1_COLL.qualifyingResults)
      .countDocuments(filter);
  }

  async countFastestLaps(params: {
    orgId: string;
    driverId?: string;
    constructorId?: string;
    seasonId?: string;
  }): Promise<number> {
    const filter: Record<string, unknown> = {
      orgId: params.orgId,
      hadFastestLap: true,
    };
    if (params.driverId) filter.driverId = params.driverId;
    if (params.constructorId) filter.constructorId = params.constructorId;
    if (params.seasonId) filter.seasonId = params.seasonId;
    return this.db.collection(F1_COLL.raceResults).countDocuments(filter);
  }

  async countDnfs(params: {
    orgId: string;
    driverId?: string;
    constructorId?: string;
    seasonId?: string;
  }): Promise<number> {
    const filter: Record<string, unknown> = {
      orgId: params.orgId,
      status: { $in: ["DNF", "DSQ"] },
    };
    if (params.driverId) filter.driverId = params.driverId;
    if (params.constructorId) filter.constructorId = params.constructorId;
    if (params.seasonId) filter.seasonId = params.seasonId;
    return this.db.collection(F1_COLL.raceResults).countDocuments(filter);
  }

  async sumPoints(params: {
    orgId: string;
    driverId?: string;
    constructorId?: string;
    seasonId?: string;
  }): Promise<number> {
    const filter: Record<string, unknown> = { orgId: params.orgId };
    if (params.driverId) filter.driverId = params.driverId;
    if (params.constructorId) filter.constructorId = params.constructorId;
    if (params.seasonId) filter.seasonId = params.seasonId;

    const agg = await this.db
      .collection(F1_COLL.raceResults)
      .aggregate<{ total: number }>([
        { $match: filter },
        {
          $group: {
            _id: null,
            total: { $sum: { $ifNull: ["$points", 0] } },
          },
        },
      ])
      .toArray();
    return agg[0]?.total ?? 0;
  }

  async avgPitStopMs(params: {
    orgId: string;
    constructorId?: string;
    grandPrixId?: string;
  }): Promise<number | null> {
    const filter: Record<string, unknown> = {
      orgId: params.orgId,
      durationMs: { $type: "number" },
    };
    if (params.constructorId) filter.constructorId = params.constructorId;
    if (params.grandPrixId) filter.grandPrixId = params.grandPrixId;

    const agg = await this.db
      .collection(F1_COLL.pitStops)
      .aggregate<{ avg: number }>([
        { $match: filter },
        { $group: { _id: null, avg: { $avg: "$durationMs" } } },
      ])
      .toArray();
    return agg[0]?.avg ?? null;
  }

  async driverSeasonStats(params: {
    orgId: string;
    driverId: string;
    seasonId: string;
  }): Promise<{
    wins: number;
    podiums: number;
    points: number;
    poles: number;
    fastestLaps: number;
    dnfs: number;
  }> {
    const [wins, podiums, points, poles, fastestLaps, dnfs] = await Promise.all([
      this.countWins(params),
      this.countPodiums(params),
      this.sumPoints(params),
      this.countPoles(params),
      this.countFastestLaps(params),
      this.countDnfs(params),
    ]);
    return { wins, podiums, points, poles, fastestLaps, dnfs };
  }

  async constructorSeasonStats(params: {
    orgId: string;
    constructorId: string;
    seasonId: string;
  }): Promise<{
    wins: number;
    podiums: number;
    points: number;
    dnfs: number;
  }> {
    const [wins, podiums, points, dnfs] = await Promise.all([
      this.countWins(params),
      this.countPodiums(params),
      this.sumPoints(params),
      this.countDnfs(params),
    ]);
    return { wins, podiums, points, dnfs };
  }

  // -------------------------------------------------------------------------
  // Fact-collection list queries
  //
  // Return row arrays scoped by any subset of (driver, constructor, season,
  // grandPrix). Used by the search tool-calling loop so the LLM can fetch
  // narrow structured slices (e.g. "Ferrari race results in 2023") and cite
  // them directly in qualitative answers.
  // -------------------------------------------------------------------------

  private factFilter(params: {
    orgId: string;
    driverId?: string;
    constructorId?: string;
    seasonId?: string;
    grandPrixId?: string;
  }): Record<string, unknown> {
    const filter: Record<string, unknown> = { orgId: params.orgId };
    if (params.driverId) filter.driverId = params.driverId;
    if (params.constructorId) filter.constructorId = params.constructorId;
    if (params.seasonId) filter.seasonId = params.seasonId;
    if (params.grandPrixId) filter.grandPrixId = params.grandPrixId;
    return filter;
  }

  async listRaceResults(params: {
    orgId: string;
    driverId?: string;
    constructorId?: string;
    seasonId?: string;
    grandPrixId?: string;
    limit?: number;
  }): Promise<RaceResultDocument[]> {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
    const docs = await this.db
      .collection(F1_COLL.raceResults)
      .find(this.factFilter(params))
      .sort({ seasonId: 1, grandPrixId: 1, position: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) =>
      this.normalizeBase(d as Record<string, unknown>),
    ) as unknown as RaceResultDocument[];
  }

  async listQualifyingResults(params: {
    orgId: string;
    driverId?: string;
    constructorId?: string;
    seasonId?: string;
    grandPrixId?: string;
    limit?: number;
  }): Promise<QualifyingResultDocument[]> {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
    const docs = await this.db
      .collection(F1_COLL.qualifyingResults)
      .find(this.factFilter(params))
      .sort({ seasonId: 1, grandPrixId: 1, gridPosition: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) =>
      this.normalizeBase(d as Record<string, unknown>),
    ) as unknown as QualifyingResultDocument[];
  }

  async listSprintResults(params: {
    orgId: string;
    driverId?: string;
    constructorId?: string;
    seasonId?: string;
    grandPrixId?: string;
    limit?: number;
  }): Promise<SprintResultDocument[]> {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
    const docs = await this.db
      .collection(F1_COLL.sprintResults)
      .find(this.factFilter(params))
      .sort({ seasonId: 1, grandPrixId: 1, position: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) =>
      this.normalizeBase(d as Record<string, unknown>),
    ) as unknown as SprintResultDocument[];
  }

  async listPitStops(params: {
    orgId: string;
    driverId?: string;
    constructorId?: string;
    seasonId?: string;
    grandPrixId?: string;
    limit?: number;
  }): Promise<PitStopDocument[]> {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
    const docs = await this.db
      .collection(F1_COLL.pitStops)
      .find(this.factFilter(params))
      .sort({ seasonId: 1, grandPrixId: 1, lap: 1, stopNumber: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) =>
      this.normalizeBase(d as Record<string, unknown>),
    ) as unknown as PitStopDocument[];
  }

  async listIncidents(params: {
    orgId: string;
    driverId?: string;
    seasonId?: string;
    grandPrixId?: string;
    limit?: number;
  }): Promise<IncidentDocument[]> {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
    const filter: Record<string, unknown> = { orgId: params.orgId };
    if (params.seasonId) filter.seasonId = params.seasonId;
    if (params.grandPrixId) filter.grandPrixId = params.grandPrixId;
    // driverIds is an array on incidents
    if (params.driverId) filter.driverIds = params.driverId;

    const docs = await this.db
      .collection(F1_COLL.incidents)
      .find(filter)
      .sort({ seasonId: 1, grandPrixId: 1, lap: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) =>
      this.normalizeBase(d as Record<string, unknown>),
    ) as unknown as IncidentDocument[];
  }

  async listPenalties(params: {
    orgId: string;
    recipientId?: string;
    seasonId?: string;
    grandPrixId?: string;
    limit?: number;
  }): Promise<PenaltyDocument[]> {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
    const filter: Record<string, unknown> = { orgId: params.orgId };
    if (params.recipientId) filter.recipientId = params.recipientId;
    if (params.seasonId) filter.seasonId = params.seasonId;
    if (params.grandPrixId) filter.grandPrixId = params.grandPrixId;

    const docs = await this.db
      .collection(F1_COLL.penalties)
      .find(filter)
      .sort({ seasonId: 1, grandPrixId: 1 })
      .limit(limit)
      .toArray();
    return docs.map((d) =>
      this.normalizeBase(d as Record<string, unknown>),
    ) as unknown as PenaltyDocument[];
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async upsertReference<T extends { name: string; nameLower: string }>(
    coll: F1CollectionName,
    params: RefUpsertInput<T>,
  ): Promise<string> {
    const now = new Date();
    const nameLower = params.name.toLowerCase();
    const aliases = uniq([params.name, ...(params.aliases ?? [])]);
    const aliasesLower = uniq(lower(aliases));
    const candidateId = params.entityId ?? newEntityId();

    // Try alias-aware lookup first (existing doc wins).
    const existing = await this.db.collection(coll).findOne({
      orgId: params.orgId,
      $or: [{ nameLower }, { aliasesLower: { $in: aliasesLower } }],
    });

    if (existing) {
      const $set: Record<string, unknown> = { updatedAt: now };
      const extra = (params.extra ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null) $set[k] = v;
      }
      const existingEntityId = String(
        (existing as unknown as { entityId: string }).entityId,
      );
      await this.db.collection(coll).updateOne(
        { orgId: params.orgId, entityId: existingEntityId },
        {
          $set,
          $addToSet: {
            sourceFileIds: params.sourceFileId,
            aliases: { $each: aliases },
            aliasesLower: { $each: aliasesLower },
          },
        },
      );
      return existingEntityId;
    }

    const extra = (params.extra ?? {}) as Record<string, unknown>;
    const insertDoc: Record<string, unknown> = {
      orgId: params.orgId,
      entityId: candidateId,
      name: params.name,
      nameLower,
      aliases,
      aliasesLower,
      sourceFileIds: [params.sourceFileId],
      createdAt: now,
      updatedAt: now,
    };
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null) insertDoc[k] = v;
    }

    await this.db.collection(coll).insertOne(insertDoc);
    return candidateId;
  }

  private async upsertFact<T extends F1BaseDocument>(
    coll: F1CollectionName,
    params: FactUpsertInput<T>,
    naturalKeyFields: readonly string[],
  ): Promise<string> {
    const now = new Date();
    const candidateId = params.entityId ?? newEntityId();
    const name =
      params.doc.name ??
      [
        coll,
        ...naturalKeyFields.map((f) =>
          String((params.doc as Record<string, unknown>)[f] ?? "any"),
        ),
      ].join(":");
    const nameLower = name.toLowerCase();

    // Natural-key filter for idempotent upserts across re-extractions.
    const filter: Record<string, unknown> = { orgId: params.orgId };
    let hasAnyKey = false;
    for (const f of naturalKeyFields) {
      const v = (params.doc as Record<string, unknown>)[f];
      if (v !== undefined && v !== null) {
        filter[f] = v;
        hasAnyKey = true;
      }
    }
    if (!hasAnyKey) {
      // No natural keys available → use a fresh entityId so we don't collapse
      // distinct facts together.
      filter.entityId = candidateId;
    }

    const $set: Record<string, unknown> = {
      name,
      nameLower,
      updatedAt: now,
    };
    const docRec = params.doc as Record<string, unknown>;
    for (const [k, v] of Object.entries(docRec)) {
      if (v !== undefined && v !== null && k !== "name") $set[k] = v;
    }

    await this.db.collection(coll).updateOne(
      filter,
      {
        $setOnInsert: {
          orgId: params.orgId,
          entityId: candidateId,
          createdAt: now,
        },
        $set,
        $addToSet: {
          sourceFileIds: params.sourceFileId,
          provenance: params.provenance,
        },
      },
      { upsert: true },
    );

    const persisted = (await this.db
      .collection(coll)
      .findOne(filter, { projection: { entityId: 1 } })) as
      | { entityId?: string }
      | null;
    return String(persisted?.entityId ?? candidateId);
  }

  private async findReferenceByNameOrAlias<T>(
    coll: F1CollectionName,
    params: { orgId: string; name: string },
  ): Promise<T | null> {
    const nameLower = params.name.toLowerCase();
    const doc = await this.db.collection(coll).findOne({
      orgId: params.orgId,
      $or: [{ nameLower }, { aliasesLower: nameLower }],
    });
    return (doc as unknown as T) ?? null;
  }

  private normalizeBase(x: Record<string, unknown>): F1BaseDocument {
    return {
      orgId: String(x.orgId),
      entityId: String(x.entityId),
      name: String(x.name),
      nameLower: String(x.nameLower ?? ""),
      sourceFileIds: Array.isArray(x.sourceFileIds)
        ? (x.sourceFileIds as string[])
        : [],
      createdAt: toIso(x.createdAt),
      updatedAt: toIso(x.updatedAt),
    };
  }
}
