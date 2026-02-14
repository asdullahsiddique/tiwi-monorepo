import type { Driver } from "neo4j-driver";

export class ArtifactRepository {
  constructor(private readonly driver: Driver) {}

  async setFileSummary(params: { orgId: string; fileId: string; summary: string }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `
MATCH (f:File {orgId: $orgId, fileId: $fileId})
SET f.summary = $summary,
    f.summaryUpdatedAt = datetime(),
    f.updatedAt = datetime()
          `,
          params,
        ),
      );
    } finally {
      await session.close();
    }
  }

  async getFileSummary(params: { orgId: string; fileId: string }): Promise<string | null> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (f:File {orgId: $orgId, fileId: $fileId})
RETURN f.summary AS summary
          `,
          params,
        ),
      );

      const record = res.records[0];
      if (!record) return null;
      return record.get("summary") ?? null;
    } finally {
      await session.close();
    }
  }
}

