import {
  ArtifactRepository,
  getMongoDb,
  EmbeddingRepository,
  FileRepository,
  LogRepository,
  EntityRepository,
  TypeRegistryRepository,
} from "@tiwi/mongodb";
import { createPresignedGetUrl } from "@tiwi/storage";

export type FileViewEntity = {
  entityId: string;
  typeName: string;
  name: string;
  properties: Record<string, unknown>;
  typeStatus?: "active" | "draft";
};

export type FileViewRelationship = {
  relationshipId: string;
  fromTypeName: string;
  fromName: string;
  toTypeName: string;
  toName: string;
  relationshipType: string;
  properties: Record<string, unknown>;
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
  entities: FileViewEntity[];
  relationships: FileViewRelationship[];
}> {
  const db = await getMongoDb();

  const fileRepo = new FileRepository(db);
  const logRepo = new LogRepository(db);
  const artifactRepo = new ArtifactRepository(db);
  const embeddingRepo = new EmbeddingRepository(db);
  const entityRepo = new EntityRepository(db);
  const typeRepo = new TypeRegistryRepository(db);

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

  const entitiesRaw = await entityRepo.getEntitiesByFile({
    orgId: params.orgId,
    fileId: params.fileId,
  });
  const relationshipsRaw = await entityRepo.getRelationshipsByFile({
    orgId: params.orgId,
    fileId: params.fileId,
  });

  const allTypes = await typeRepo.listTypes({ orgId: params.orgId });
  const typeStatusMap = new Map<string, "active" | "draft">(
    allTypes.map((t) => [t.typeName, t.status]),
  );

  const entities: FileViewEntity[] = entitiesRaw.map((e) => ({
    entityId: e.entityId,
    typeName: e.typeName,
    name: e.name,
    properties: e.properties,
    typeStatus: typeStatusMap.get(e.typeName),
  }));

  const relationships: FileViewRelationship[] = relationshipsRaw.map((r) => ({
    relationshipId: r.relationshipId,
    fromTypeName: r.fromTypeName,
    fromName: r.fromName,
    toTypeName: r.toTypeName,
    toName: r.toName,
    relationshipType: r.relationshipType,
    properties: r.properties,
  }));

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
    entities,
    relationships,
  };
}
