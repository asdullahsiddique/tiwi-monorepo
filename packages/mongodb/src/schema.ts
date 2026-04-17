import type { Db } from "mongodb";
import { COLL } from "./collections";
import { F1_COLL, F1_REFERENCE_COLLECTIONS } from "./f1Documents";

const globalForIndexes = globalThis as unknown as {
  tiwiEnsureIndexesPromise?: Promise<void>;
};

/**
 * Create indexes once per process (idempotent).
 *
 * Runs fire-and-forget: callers don't await it so the first request doesn't
 * pay the cost of creating ~50 Atlas indexes (which can exceed browser fetch
 * timeouts). Queries work without indexes — they're only an optimization.
 */
export function ensureMongoIndexes(db: Db): Promise<void> {
  if (globalForIndexes.tiwiEnsureIndexesPromise) {
    return globalForIndexes.tiwiEnsureIndexesPromise;
  }
  const promise = (async () => {
    // --- Core platform collections ---
    await db.collection(COLL.organizations).createIndex({ orgId: 1 }, { unique: true });
    await db.collection(COLL.users).createIndex({ orgId: 1, userId: 1 }, { unique: true });
    await db.collection(COLL.files).createIndex({ orgId: 1, fileId: 1 }, { unique: true });
    await db.collection(COLL.files).createIndex({ orgId: 1, status: 1 });
    await db.collection(COLL.processingLogs).createIndex({ orgId: 1, fileId: 1, createdAt: -1 });
    await db.collection(COLL.aiExecutionLogs).createIndex({ orgId: 1, fileId: 1, createdAt: -1 });
    await db.collection(COLL.embeddingChunks).createIndex({ orgId: 1, chunkId: 1 }, { unique: true });
    await db.collection(COLL.embeddingChunks).createIndex({ orgId: 1, fileId: 1 });
    await db.collection(COLL.searchHistory).createIndex({ orgId: 1, userId: 1, createdAt: -1 });
    await db.collection(COLL.fileProcessingJobs).createIndex({ status: 1, createdAt: 1 });

    // --- F1 collections: shared indexes (entityId uniqueness + fileIds lookup) ---
    for (const coll of Object.values(F1_COLL)) {
      await db.collection(coll).createIndex({ orgId: 1, entityId: 1 }, { unique: true });
      await db.collection(coll).createIndex({ orgId: 1, sourceFileIds: 1 });
    }

    // --- F1 reference entities: nameLower unique dedup + aliasesLower lookup ---
    for (const coll of F1_REFERENCE_COLLECTIONS) {
      await db.collection(coll).createIndex({ orgId: 1, nameLower: 1 }, { unique: true });
      await db.collection(coll).createIndex({ orgId: 1, aliasesLower: 1 });
    }

    // --- F1: season year is its own identifier ---
    await db.collection(F1_COLL.seasons).createIndex({ orgId: 1, year: 1 });

    // --- F1 results: quantitative aggregation indexes ---
    await db.collection(F1_COLL.raceResults).createIndex({ orgId: 1, driverId: 1, seasonId: 1 });
    await db.collection(F1_COLL.raceResults).createIndex({ orgId: 1, constructorId: 1, seasonId: 1 });
    await db.collection(F1_COLL.raceResults).createIndex({ orgId: 1, grandPrixId: 1 });

    await db.collection(F1_COLL.qualifyingResults).createIndex({ orgId: 1, driverId: 1, seasonId: 1 });
    await db.collection(F1_COLL.qualifyingResults).createIndex({ orgId: 1, grandPrixId: 1 });

    await db.collection(F1_COLL.sprintResults).createIndex({ orgId: 1, driverId: 1, seasonId: 1 });
    await db.collection(F1_COLL.sprintResults).createIndex({ orgId: 1, grandPrixId: 1 });

    await db.collection(F1_COLL.pitStops).createIndex({ orgId: 1, constructorId: 1, grandPrixId: 1 });
    await db.collection(F1_COLL.pitStops).createIndex({ orgId: 1, driverId: 1, grandPrixId: 1 });

    // --- F1 driver seats: time-bounded lookups ---
    await db.collection(F1_COLL.driverSeats).createIndex({ orgId: 1, driverId: 1, seasonId: 1 });
    await db.collection(F1_COLL.driverSeats).createIndex({ orgId: 1, constructorId: 1, seasonId: 1 });

    // --- F1 regulatory ---
    await db.collection(F1_COLL.incidents).createIndex({ orgId: 1, grandPrixId: 1 });
    await db.collection(F1_COLL.penalties).createIndex({ orgId: 1, recipientId: 1, seasonId: 1 });
  })();
  // Swallow errors so a transient failure doesn't break all future calls.
  promise.catch((err) => {
    console.warn("[mongodb] ensureMongoIndexes failed:", err);
  });
  globalForIndexes.tiwiEnsureIndexesPromise = promise;
  return promise;
}
