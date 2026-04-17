import {
  ArtifactRepository,
  getMongoDb,
  EmbeddingRepository,
  FileRepository,
  LogRepository,
  F1Repository,
  type F1BaseDocument,
  type F1CollectionName,
} from "@tiwi/mongodb";
import { createPresignedGetUrl } from "@tiwi/storage";

export type FileViewEntityGroup = {
  collection: F1CollectionName;
  docs: F1BaseDocument[];
};

export async function getFileView(params: {
  orgId: string;
  fileId: string;
  logsLimit?: number;
}): Promise<{
  file: Awaited<ReturnType<FileRepository["getFile"]>>;
  downloadUrl: string | null;
  previewUrl: string | null;
  summary: string | null;
  processingLogs: Awaited<ReturnType<LogRepository["listProcessingLogs"]>>;
  aiLogs: Awaited<ReturnType<LogRepository["listAIExecutionLogs"]>>;
  embeddingsMeta: Awaited<ReturnType<EmbeddingRepository["getEmbeddingsMeta"]>>;
  f1Entities: FileViewEntityGroup[];
}> {
  const db = await getMongoDb();

  const fileRepo = new FileRepository(db);
  const logRepo = new LogRepository(db);
  const artifactRepo = new ArtifactRepository(db);
  const embeddingRepo = new EmbeddingRepository(db);
  const f1Repo = new F1Repository(db);

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

  const f1Entities = await f1Repo.getEntitiesByFile({
    orgId: params.orgId,
    fileId: params.fileId,
  });

  const downloadUrl = file
    ? await createPresignedGetUrl({
        objectKey: file.objectKey,
        expiresInSeconds: 60 * 10,
      })
    : null;

  const previewUrl = file ? `/api/files/${file.fileId}/preview` : null;

  return {
    file,
    downloadUrl,
    previewUrl,
    summary,
    processingLogs,
    aiLogs,
    embeddingsMeta,
    f1Entities,
  };
}
