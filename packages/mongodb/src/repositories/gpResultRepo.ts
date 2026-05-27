import type { Db } from "mongodb";
import { COLL } from "../collections";

export type PoleOrFastestLap = {
  driver?: string;
  team?: string;
  time?: string;
};

export type RaceResultEntry = {
  position?: number | string;
  driver: string;
  team?: string;
  car?: string;
  timeOrGap?: string;
  points?: number;
};

export type GpRaceResultRow = RaceResultEntry;

export type RaceResult = {
  raceNumber: number;
  polePosition?: PoleOrFastestLap;
  fastestLap?: PoleOrFastestLap;
  results: RaceResultEntry[];
};

export type CategoryResult = {
  name:
    | "TROFEO PIRELLI"
    | "TROFEO PIRELLI AM"
    | "COPPA SHELL"
    | "COPPA SHELL AM"
    | "TROFEO PIRELLI MID";
  races: RaceResult[];
};

export type GpSingleRaceResultDocument = {
  type: "single";
  orgId: string;
  fileId: string;
  grandPrix: string;
  circuit: string;
  country?: string;
  dateStart?: string;
  dateEnd?: string;
  polePosition?: PoleOrFastestLap;
  fastestLap?: PoleOrFastestLap;
  results: RaceResultEntry[];
  extractedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type GpMultiClassRoundDocument = {
  type: "multi-class";
  orgId: string;
  fileId: string;
  championship: string;
  grandPrix: string;
  circuit: string;
  country?: string;
  dateStart?: string;
  dateEnd?: string;
  round?: number;
  totalRounds?: number;
  categories: CategoryResult[];
  extractedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type GpRoundResultDocument =
  | GpSingleRaceResultDocument
  | GpMultiClassRoundDocument;

export type GpRoundResultPayload =
  | Omit<
      GpSingleRaceResultDocument,
      "orgId" | "fileId" | "extractedAt" | "createdAt" | "updatedAt"
    >
  | Omit<
      GpMultiClassRoundDocument,
      "orgId" | "fileId" | "extractedAt" | "createdAt" | "updatedAt"
    >;

export type GpRaceResultQueryResult =
  GpRoundResultDocument extends infer T
    ? T extends GpRoundResultDocument
      ? Omit<T, "orgId" | "createdAt" | "updatedAt">
      : never
    : never;

const globalForGpResultIndexes = globalThis as unknown as {
  tiwiEnsureGpResultIndexesPromise?: Promise<void>;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toIso(d: unknown): string {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string") return d;
  return new Date().toISOString();
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function normalizePoleOrFastestLap(value: unknown): PoleOrFastestLap | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    driver: normalizeOptionalString(raw.driver),
    team: normalizeOptionalString(raw.team),
    time: normalizeOptionalString(raw.time),
  };
}

function normalizeRaceResultEntry(value: unknown): RaceResultEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.driver !== "string" || raw.driver.length === 0) return null;
  return {
    position:
      typeof raw.position === "number" || typeof raw.position === "string"
        ? raw.position
        : undefined,
    driver: raw.driver,
    team: normalizeOptionalString(raw.team),
    car: normalizeOptionalString(raw.car),
    timeOrGap: normalizeOptionalString(raw.timeOrGap),
    points: normalizeOptionalNumber(raw.points),
  };
}

function normalizeRace(value: unknown): RaceResult | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.raceNumber !== "number") return null;
  return {
    raceNumber: raw.raceNumber,
    polePosition: normalizePoleOrFastestLap(raw.polePosition),
    fastestLap: normalizePoleOrFastestLap(raw.fastestLap),
    results: Array.isArray(raw.results)
      ? raw.results
          .map((entry) => normalizeRaceResultEntry(entry))
          .filter((entry): entry is RaceResultEntry => Boolean(entry))
      : [],
  };
}

function normalizeCategory(value: unknown): CategoryResult | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string") return null;
  return {
    name: raw.name as CategoryResult["name"],
    races: Array.isArray(raw.races)
      ? raw.races
          .map((race) => normalizeRace(race))
          .filter((race): race is RaceResult => Boolean(race))
      : [],
  };
}

function docToRoundResult(doc: Record<string, unknown>): GpRoundResultDocument {
  const base = {
    orgId: String(doc.orgId),
    fileId: String(doc.fileId),
    grandPrix: String(doc.grandPrix),
    circuit: String(doc.circuit),
    country: normalizeOptionalString(doc.country),
    dateStart: normalizeOptionalString(doc.dateStart),
    dateEnd: normalizeOptionalString(doc.dateEnd),
    extractedAt: toIso(doc.extractedAt),
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };

  if (doc.type === "multi-class") {
    return {
      type: "multi-class",
      ...base,
      championship: String(doc.championship),
      round: normalizeOptionalNumber(doc.round),
      totalRounds: normalizeOptionalNumber(doc.totalRounds),
      categories: Array.isArray(doc.categories)
        ? doc.categories
            .map((category) => normalizeCategory(category))
            .filter((category): category is CategoryResult => Boolean(category))
        : [],
    };
  }

  return {
    type: "single",
    ...base,
    polePosition: normalizePoleOrFastestLap(doc.polePosition),
    fastestLap: normalizePoleOrFastestLap(doc.fastestLap),
    results: Array.isArray(doc.results)
      ? doc.results
          .map((entry) => normalizeRaceResultEntry(entry))
          .filter((entry): entry is RaceResultEntry => Boolean(entry))
      : [],
  };
}

function stripTenantFields(
  doc: GpRoundResultDocument,
): GpRaceResultQueryResult {
  const { orgId: _orgId, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } =
    doc;
  return rest;
}

function textIncludes(value: unknown, needle: string | undefined): boolean {
  if (!needle) return true;
  return typeof value === "string"
    ? value.toLowerCase().includes(needle.toLowerCase())
    : false;
}

function rowMatches(
  row: RaceResultEntry,
  params: { driverName?: string; teamName?: string },
): boolean {
  return (
    textIncludes(row.driver, params.driverName) &&
    textIncludes(row.team, params.teamName)
  );
}

function roundMatchesRows(
  round: GpRoundResultDocument,
  params: { driverName?: string; teamName?: string },
): boolean {
  if (!params.driverName && !params.teamName) return true;
  if (round.type === "single") {
    return round.results.some((row) => rowMatches(row, params));
  }
  return round.categories.some((category) =>
    category.races.some((race) =>
      race.results.some((row) => rowMatches(row, params)),
    ),
  );
}

async function ensureGpResultIndexes(db: Db): Promise<void> {
  if (globalForGpResultIndexes.tiwiEnsureGpResultIndexesPromise) {
    return globalForGpResultIndexes.tiwiEnsureGpResultIndexesPromise;
  }

  const promise = (async () => {
    const collection = db.collection(COLL.gpRaceResults);
    const indexes = await collection.indexes();
    const fileIndex = indexes.find((index) => index.name === "orgId_1_fileId_1");
    if (fileIndex?.unique) {
      await collection.dropIndex("orgId_1_fileId_1");
    }
    await collection.createIndex({ orgId: 1, fileId: 1 });
    await collection.createIndex({ orgId: 1, championship: 1, round: 1 });
  })();

  globalForGpResultIndexes.tiwiEnsureGpResultIndexesPromise = promise;
  return promise;
}

export class GpResultRepository {
  constructor(private readonly db: Db) {}

  async replaceRoundsForFile(params: {
    orgId: string;
    fileId: string;
    rounds: GpRoundResultPayload[];
    extractedAt?: Date;
  }): Promise<void> {
    const now = new Date();
    await ensureGpResultIndexes(this.db);

    await this.db.collection(COLL.gpRaceResults).deleteMany({
      orgId: params.orgId,
      fileId: params.fileId,
    });

    if (params.rounds.length === 0) return;

    await this.db.collection(COLL.gpRaceResults).insertMany(
      params.rounds.map((round) => ({
        orgId: params.orgId,
        fileId: params.fileId,
        ...round,
        extractedAt: params.extractedAt ?? now,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }

  async listRoundsForFile(params: {
    orgId: string;
    fileId: string;
  }): Promise<GpRoundResultDocument[]> {
    const docs = await this.db
      .collection(COLL.gpRaceResults)
      .find({ orgId: params.orgId, fileId: params.fileId })
      .sort({ championship: 1, round: 1, dateStart: 1, grandPrix: 1 })
      .toArray();

    return docs.map((raw) => docToRoundResult(raw as Record<string, unknown>));
  }

  async query(params: {
    orgId: string;
    driverName?: string;
    teamName?: string;
    grandPrixName?: string;
    championship?: string;
    categoryName?: CategoryResult["name"];
    country?: string;
    fileId?: string;
    limit?: number;
  }): Promise<GpRaceResultQueryResult[]> {
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
    const filter: Record<string, unknown> = { orgId: params.orgId };

    if (params.fileId) filter.fileId = params.fileId;
    if (params.grandPrixName) {
      filter.grandPrix = {
        $regex: escapeRegex(params.grandPrixName),
        $options: "i",
      };
    }
    if (params.championship) {
      filter.championship = {
        $regex: escapeRegex(params.championship),
        $options: "i",
      };
    }
    if (params.country) {
      filter.country = {
        $regex: escapeRegex(params.country),
        $options: "i",
      };
    }
    if (params.categoryName) {
      filter["categories.name"] = params.categoryName;
    }

    const docs = await this.db
      .collection(COLL.gpRaceResults)
      .find(filter)
      .sort({ extractedAt: -1, championship: 1, round: 1, grandPrix: 1 })
      .limit(limit * 4)
      .toArray();

    return docs
      .map((raw) => docToRoundResult(raw as Record<string, unknown>))
      .filter((round) => roundMatchesRows(round, params))
      .slice(0, limit)
      .map(stripTenantFields);
  }
}
