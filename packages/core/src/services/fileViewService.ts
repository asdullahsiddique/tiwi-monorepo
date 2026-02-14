import {
  ArtifactRepository,
  getNeo4jDriver,
  EmbeddingRepository,
  ensureNeo4jSchema,
  FileRepository,
  LogRepository,
} from "@tiwi/neo4j";
import { createPresignedGetUrl } from "@tiwi/storage";

export async function getFileView(params: {
  orgId: string;
  fileId: string;
  logsLimit?: number;
}): Promise<{
  file: Awaited<ReturnType<FileRepository["getFile"]>>;
  downloadUrl: string | null;
  summary: string | null;
  processingLogs: Awaited<ReturnType<LogRepository["listProcessingLogs"]>>;
  aiLogs: Awaited<ReturnType<LogRepository["listAIExecutionLogs"]>>;
  embeddingsMeta: Awaited<ReturnType<EmbeddingRepository["getEmbeddingsMeta"]>>;
  entities: Array<unknown>;
  relationships: Array<unknown>;
}> {
  const driver = getNeo4jDriver();
  await ensureNeo4jSchema(driver);

  const fileRepo = new FileRepository(driver);
  const logRepo = new LogRepository(driver);
  const artifactRepo = new ArtifactRepository(driver);
  const embeddingRepo = new EmbeddingRepository(driver);

  const file = await fileRepo.getFile({
    orgId: params.orgId,
    fileId: params.fileId,
  });
  const summary = await artifactRepo.getFileSummary({
    orgId: params.orgId,
    fileId: params.fileId,
  });
  const embeddingsMeta = await embeddingRepo.getEmbeddingsMeta({
    orgId: params.orgId,
    fileId: params.fileId,
  });

  const limit = params.logsLimit ?? 50;
  const processingLogs = await logRepo.listProcessingLogs({
    orgId: params.orgId,
    fileId: params.fileId,
    limit,
    offset: 0,
  });
  const aiLogs = await logRepo.listAIExecutionLogs({
    orgId: params.orgId,
    fileId: params.fileId,
    limit,
    offset: 0,
  });

  const downloadUrl = file
    ? await createPresignedGetUrl({
        objectKey: file.objectKey,
        expiresInSeconds: 60 * 10,
      })
    : null;

  return {
    file,
    downloadUrl,
    summary,
    processingLogs,
    aiLogs,
    embeddingsMeta,
    entities: [],
    relationships: [],
  };
}
