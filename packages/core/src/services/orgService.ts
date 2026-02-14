import { createNeo4jDriver, ensureNeo4jSchema, OrgRepository } from "@tiwi/neo4j";

export async function ensureGraphMirror(params: { orgId: string; userId: string }): Promise<void> {
  const driver = createNeo4jDriver();
  try {
    await ensureNeo4jSchema(driver);
    const repo = new OrgRepository(driver);
    await repo.ensureOrgAndUser(params);
  } finally {
    await driver.close();
  }
}

