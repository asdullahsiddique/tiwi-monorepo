import type { Db } from "mongodb";
import { COLL } from "./collections";

let ensurePromise: Promise<void> | null = null;

/**
 * Create indexes once per process (idempotent).
 */
export async function ensureMongoIndexes(db: Db): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    await db.collection(COLL.organizations).createIndex({ orgId: 1 }, { unique: true });
    await db.collection(COLL.users).createIndex({ orgId: 1, userId: 1 }, { unique: true });
    await db.collection(COLL.files).createIndex({ orgId: 1, fileId: 1 }, { unique: true });
    await db.collection(COLL.files).createIndex({ orgId: 1, status: 1 });
    await db.collection(COLL.processingLogs).createIndex({ orgId: 1, fileId: 1, createdAt: -1 });
    await db.collection(COLL.aiExecutionLogs).createIndex({ orgId: 1, fileId: 1, createdAt: -1 });
    await db.collection(COLL.embeddingChunks).createIndex({ orgId: 1, chunkId: 1 }, { unique: true });
    await db.collection(COLL.embeddingChunks).createIndex({ orgId: 1, fileId: 1 });
    await db.collection(COLL.entities).createIndex({ orgId: 1, entityId: 1 }, { unique: true });
    await db.collection(COLL.entities).createIndex(
      { orgId: 1, typeName: 1, nameLower: 1 },
      { unique: true },
    );
    await db.collection(COLL.entities).createIndex({ orgId: 1, sourceFileIds: 1 });
    await db.collection(COLL.entityRelationships).createIndex({ orgId: 1, relationshipId: 1 }, { unique: true });
    await db.collection(COLL.entityRelationships).createIndex({ orgId: 1, sourceFileId: 1 });
    await db.collection(COLL.typeRegistry).createIndex({ orgId: 1, typeName: 1 }, { unique: true });
    await db.collection(COLL.searchHistory).createIndex({ orgId: 1, userId: 1, createdAt: -1 });
    await db.collection(COLL.fileProcessingJobs).createIndex({ status: 1, createdAt: 1 });
  })();
  return ensurePromise;
}
