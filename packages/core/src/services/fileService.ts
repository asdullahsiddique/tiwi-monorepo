import { getNeo4jDriver, ensureNeo4jSchema, FileRepository } from "@tiwi/neo4j";

export async function listFiles(params: {
  orgId: string;
  limit: number;
  offset: number;
}) {
  const driver = getNeo4jDriver();
  await ensureNeo4jSchema(driver);
  const repo = new FileRepository(driver);
  return repo.listFiles(params);
}

export async function getFile(params: { orgId: string; fileId: string }) {
  const driver = getNeo4jDriver();
  await ensureNeo4jSchema(driver);
  const repo = new FileRepository(driver);
  return repo.getFile(params);
}
