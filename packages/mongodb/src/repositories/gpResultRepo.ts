import type { Db } from "mongodb";
import { COLL } from "../collections";

export type GpRaceResultRow = {
  position?: number | string;
  driver: string;
  team: string;
  car?: string;
  timeOrGap?: string;
  points?: number;
};

export type GpRaceResultDocument = {
  orgId: string;
  fileId: string;
  grandPrix: string;
  circuit: string;
  country?: string;
  dateStart?: string;
  dateEnd?: string;
  results: GpRaceResultRow[];
  extractedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type GpRaceResultQueryResult = Omit<
  GpRaceResultDocument,
  "orgId" | "createdAt" | "updatedAt"
>;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toIso(d: unknown): string {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string") return d;
  return new Date().toISOString();
}

function docToGpRaceResult(doc: Record<string, unknown>): GpRaceResultDocument {
  return {
    orgId: String(doc.orgId),
    fileId: String(doc.fileId),
    grandPrix: String(doc.grandPrix),
    circuit: String(doc.circuit),
    country: doc.country ? String(doc.country) : undefined,
    dateStart: doc.dateStart ? String(doc.dateStart) : undefined,
    dateEnd: doc.dateEnd ? String(doc.dateEnd) : undefined,
    results: Array.isArray(doc.results)
      ? (doc.results as GpRaceResultRow[])
      : [],
    extractedAt: toIso(doc.extractedAt),
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

export class GpResultRepository {
  constructor(private readonly db: Db) {}

  async upsertForFile(params: {
    orgId: string;
    fileId: string;
    grandPrix: string;
    circuit: string;
    country?: string;
    dateStart?: string;
    dateEnd?: string;
    results: GpRaceResultRow[];
    extractedAt?: Date;
  }): Promise<void> {
    const now = new Date();
    await this.db.collection(COLL.gpRaceResults).updateOne(
      { orgId: params.orgId, fileId: params.fileId },
      {
        $set: {
          orgId: params.orgId,
          fileId: params.fileId,
          grandPrix: params.grandPrix,
          circuit: params.circuit,
          country: params.country ?? null,
          dateStart: params.dateStart ?? null,
          dateEnd: params.dateEnd ?? null,
          results: params.results,
          extractedAt: params.extractedAt ?? now,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }

  async getByFileId(params: {
    orgId: string;
    fileId: string;
  }): Promise<GpRaceResultDocument | null> {
    const doc = await this.db.collection(COLL.gpRaceResults).findOne({
      orgId: params.orgId,
      fileId: params.fileId,
    });
    if (!doc) return null;
    return docToGpRaceResult(doc as Record<string, unknown>);
  }

  async query(params: {
    orgId: string;
    driverName?: string;
    teamName?: string;
    grandPrixName?: string;
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
    if (params.country) {
      filter.country = {
        $regex: escapeRegex(params.country),
        $options: "i",
      };
    }
    if (params.driverName || params.teamName) {
      const rowFilter: Record<string, unknown> = {};
      if (params.driverName) {
        rowFilter.driver = {
          $regex: escapeRegex(params.driverName),
          $options: "i",
        };
      }
      if (params.teamName) {
        rowFilter.team = {
          $regex: escapeRegex(params.teamName),
          $options: "i",
        };
      }
      filter.results = { $elemMatch: rowFilter };
    }

    const docs = await this.db
      .collection(COLL.gpRaceResults)
      .find(filter)
      .sort({ extractedAt: -1 })
      .limit(limit)
      .toArray();

    return docs.map((raw) => {
      const doc = docToGpRaceResult(raw as Record<string, unknown>);
      const rows = doc.results.filter((row) => {
        const driverMatches =
          !params.driverName ||
          row.driver.toLowerCase().includes(params.driverName.toLowerCase());
        const teamMatches =
          !params.teamName ||
          row.team.toLowerCase().includes(params.teamName.toLowerCase());
        return driverMatches && teamMatches;
      });

      return {
        fileId: doc.fileId,
        grandPrix: doc.grandPrix,
        circuit: doc.circuit,
        country: doc.country,
        dateStart: doc.dateStart,
        dateEnd: doc.dateEnd,
        extractedAt: doc.extractedAt,
        results:
          params.driverName || params.teamName ? rows : doc.results.slice(0, 50),
      };
    });
  }
}
