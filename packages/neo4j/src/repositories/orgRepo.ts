import type { Driver } from "neo4j-driver";

export class OrgRepository {
  constructor(private readonly driver: Driver) {}

  async ensureOrgAndUser(params: {
    orgId: string;
    userId: string;
  }): Promise<void> {
    const { orgId, userId } = params;
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite(async (tx) => {
        await tx.run(
          `
MERGE (o:Organization {orgId: $orgId})
  ON CREATE SET o.createdAt = datetime(), o.updatedAt = datetime()
  ON MATCH SET o.updatedAt = datetime()
MERGE (u:User {orgId: $orgId, userId: $userId})
  ON CREATE SET u.createdAt = datetime(), u.updatedAt = datetime()
  ON MATCH SET u.updatedAt = datetime()
MERGE (u)-[:MEMBER_OF]->(o)
          `,
          { orgId, userId },
        );
      });
    } finally {
      await session.close();
    }
  }
}

