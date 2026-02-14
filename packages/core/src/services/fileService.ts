import { createNeo4jDriver, ensureNeo4jSchema, FileRepository } from "@tiwi/neo4j";

export async function listFiles(params: { orgId: string; limit: number; offset: number }) {
  const driver = createNeo4jDriver();
  try {
    await ensureNeo4jSchema(driver);
    const repo = new FileRepository(driver);
    return repo.listFiles(params);
  } finally {
    await driver.close();
  }
}

export async function getFile(params: { orgId: string; fileId: string }) {
  const driver = createNeo4jDriver();
  try {
    await ensureNeo4jSchema(driver);
    const repo = new FileRepository(driver);
    return repo.getFile(params);
  } finally {
    await driver.close();
  }
}

