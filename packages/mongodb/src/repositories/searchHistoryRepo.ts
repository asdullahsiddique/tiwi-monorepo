import type { Db } from "mongodb";
import { COLL } from "../collections";

export type SearchHistoryRecord = {
  searchId: string;
  orgId: string;
  userId: string;
  query: string;
  answer: string | null;
  citationCount: number;
  createdAt: string;
};

function toIso(d: unknown): string {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string") return d;
  return "";
}

export class SearchHistoryRepository {
  constructor(private readonly db: Db) {}

  async saveSearch(params: {
    orgId: string;
    userId: string;
    searchId: string;
    query: string;
    answer: string | null;
    citationCount: number;
  }): Promise<void> {
    await this.db.collection(COLL.searchHistory).insertOne({
      searchId: params.searchId,
      orgId: params.orgId,
      userId: params.userId,
      query: params.query,
      answer: params.answer,
      citationCount: params.citationCount,
      createdAt: new Date(),
    });
  }

  async getSearchHistory(params: {
    orgId: string;
    userId: string;
    limit?: number;
  }): Promise<SearchHistoryRecord[]> {
    const limit = params.limit ?? 20;
    const docs = await this.db
      .collection(COLL.searchHistory)
      .find({ orgId: params.orgId, userId: params.userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return docs.map((d) => {
      const x = d as Record<string, unknown>;
      return {
        searchId: String(x.searchId),
        orgId: String(x.orgId),
        userId: String(x.userId),
        query: String(x.query),
        answer: x.answer != null ? String(x.answer) : null,
        citationCount: Number(x.citationCount ?? 0),
        createdAt: toIso(x.createdAt),
      };
    });
  }

  async deleteSearch(params: {
    orgId: string;
    userId: string;
    searchId: string;
  }): Promise<boolean> {
    const res = await this.db.collection(COLL.searchHistory).deleteOne({
      orgId: params.orgId,
      userId: params.userId,
      searchId: params.searchId,
    });
    return res.deletedCount > 0;
  }

  async clearHistory(params: { orgId: string; userId: string }): Promise<number> {
    const res = await this.db.collection(COLL.searchHistory).deleteMany({
      orgId: params.orgId,
      userId: params.userId,
    });
    return res.deletedCount ?? 0;
  }
}
