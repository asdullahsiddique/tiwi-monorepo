import {
  ArtifactRepository,
  getNeo4jDriver,
  EmbeddingRepository,
  ensureNeo4jSchema,
  FileRepository,
  LogRepository,
  EntityRepository,
  type EntityRecord,
  type RelationshipRecord,
} from "@tiwi/neo4j";
import { createPresignedGetUrl } from "@tiwi/storage";

export type FileViewEntity = {
  entityId: string;
  typeName: string;
  name: string;
  properties: Record<string, unknown>;
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
  summary: string | null;
  processingLogs: Awaited<ReturnType<LogRepository["listProcessingLogs"]>>;
  aiLogs: Awaited<ReturnType<LogRepository["listAIExecutionLogs"]>>;
  embeddingsMeta: Awaited<ReturnType<EmbeddingRepository["getEmbeddingsMeta"]>>;
  entities: FileViewEntity[];
  relationships: FileViewRelationship[];
}> {
  const driver = getNeo4jDriver();
  await ensureNeo4jSchema(driver);

  const fileRepo = new FileRepository(driver);
  const logRepo = new LogRepository(driver);
  const artifactRepo = new ArtifactRepository(driver);
  const embeddingRepo = new EmbeddingRepository(driver);
  const entityRepo = new EntityRepository(driver);

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

  // Fetch entities and relationships extracted from this file
  const entitiesRaw = await entityRepo.getEntitiesByFile({
    orgId: params.orgId,
    fileId: params.fileId,
  });
  const relationshipsRaw = await entityRepo.getRelationshipsByFile({
    orgId: params.orgId,
    fileId: params.fileId,
  });

  const entities: FileViewEntity[] = entitiesRaw.map((e) => ({
    entityId: e.entityId,
    typeName: e.typeName,
    name: e.name,
    properties: e.properties,
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

  return {
    file,
    downloadUrl,
    summary,
    processingLogs,
    aiLogs,
    embeddingsMeta,
    entities,
    relationships,
  };
}
