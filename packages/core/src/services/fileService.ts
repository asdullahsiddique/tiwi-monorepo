import { getMongoDb, FileRepository } from "@tiwi/mongodb";
import { getObjectContent } from "@tiwi/storage";

export async function listFiles(params: {
  orgId: string;
  limit: number;
  offset: number;
}) {
  const db = await getMongoDb();
  const repo = new FileRepository(db);
  return repo.listFiles(params);
}

export async function getFile(params: { orgId: string; fileId: string }) {
  const db = await getMongoDb();
  const repo = new FileRepository(db);
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
