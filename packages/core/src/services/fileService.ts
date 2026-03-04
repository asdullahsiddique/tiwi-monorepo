import { getNeo4jDriver, ensureNeo4jSchema, FileRepository } from "@tiwi/neo4j";
import { getObjectContent } from "@tiwi/storage";

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

export async function getFileContent(params: { orgId: string; fileId: string }): Promise<{
  buffer: Buffer;
  contentType: string;
  filename: string;
} | null> {
  const file = await getFile(params);
  if (!file) return null;

  const buffer = await getObjectContent({ objectKey: file.objectKey });
  if (!buffer) return null;

  return {
    buffer,
    contentType: file.contentType,
    filename: file.originalName,
  };
}
