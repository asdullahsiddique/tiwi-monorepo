import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";

export type SearchHistoryRecord = {
  searchId: string;
  orgId: string;
  userId: string;
  query: string;
  answer: string | null;
  citationCount: number;
  createdAt: string;
};

export class SearchHistoryRepository {
  constructor(private readonly driver: Driver) {}

  /**
   * Save a search to history.
   */
  async saveSearch(params: {
    orgId: string;
    userId: string;
    searchId: string;
    query: string;
    answer: string | null;
    citationCount: number;
  }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `
CREATE (s:SearchHistory {
  searchId: $searchId,
  orgId: $orgId,
  userId: $userId,
  query: $query,
  answer: $answer,
  citationCount: $citationCount,
  createdAt: datetime()
})
          `,
          {
            searchId: params.searchId,
            orgId: params.orgId,
            userId: params.userId,
            query: params.query,
            answer: params.answer,
            citationCount: neo4j.int(params.citationCount),
          }
        )
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Get search history for a user.
   */
  async getSearchHistory(params: {
    orgId: string;
    userId: string;
    limit?: number;
  }): Promise<SearchHistoryRecord[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (s:SearchHistory {orgId: $orgId, userId: $userId})
RETURN s.searchId AS searchId,
       s.orgId AS orgId,
       s.userId AS userId,
       s.query AS query,
       s.answer AS answer,
       s.citationCount AS citationCount,
       toString(s.createdAt) AS createdAt
ORDER BY s.createdAt DESC
LIMIT $limit
          `,
          {
            orgId: params.orgId,
            userId: params.userId,
            limit: neo4j.int(params.limit ?? 20),
          }
        )
      );

      return result.records.map((r) => ({
        searchId: r.get("searchId"),
        orgId: r.get("orgId"),
        userId: r.get("userId"),
        query: r.get("query"),
        answer: r.get("answer"),
        citationCount: neo4j.isInt(r.get("citationCount"))
          ? r.get("citationCount").toNumber()
          : Number(r.get("citationCount")) || 0,
        createdAt: r.get("createdAt"),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Delete a search from history.
   */
  async deleteSearch(params: {
    orgId: string;
    userId: string;
    searchId: string;
  }): Promise<boolean> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      const result = await session.executeWrite((tx) =>
        tx.run(
          `
MATCH (s:SearchHistory {orgId: $orgId, userId: $userId, searchId: $searchId})
DELETE s
RETURN count(s) AS deleted
          `,
          {
            orgId: params.orgId,
            userId: params.userId,
            searchId: params.searchId,
          }
        )
      );

      const deleted = result.records[0]?.get("deleted");
      return neo4j.isInt(deleted) ? deleted.toNumber() > 0 : Number(deleted) > 0;
    } finally {
      await session.close();
    }
  }

  /**
   * Clear all search history for a user.
   */
  async clearHistory(params: { orgId: string; userId: string }): Promise<number> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      const result = await session.executeWrite((tx) =>
        tx.run(
          `
MATCH (s:SearchHistory {orgId: $orgId, userId: $userId})
WITH s, count(s) AS total
DELETE s
RETURN total
          `,
          {
            orgId: params.orgId,
            userId: params.userId,
          }
        )
      );

      const total = result.records[0]?.get("total");
      return neo4j.isInt(total) ? total.toNumber() : Number(total) || 0;
    } finally {
      await session.close();
    }
  }
}
