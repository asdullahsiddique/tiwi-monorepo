import type { Driver } from "neo4j-driver";

/**
 * Minimal schema bootstrap for v1.
 * Safe to run on every startup (IF NOT EXISTS).
 */
export async function ensureNeo4jSchema(driver: Driver): Promise<void> {
  const session = driver.session({ defaultAccessMode: "WRITE" });
  try {
    await session.executeWrite(async (tx) => {
      // Core uniqueness constraints (multi-tenant safe)
      await tx.run(
        "CREATE CONSTRAINT org_orgId IF NOT EXISTS FOR (o:Organization) REQUIRE o.orgId IS UNIQUE",
      );

      await tx.run(
        "CREATE CONSTRAINT user_userId_orgId IF NOT EXISTS FOR (u:User) REQUIRE (u.userId, u.orgId) IS UNIQUE",
      );

      await tx.run(
        "CREATE CONSTRAINT file_fileId_orgId IF NOT EXISTS FOR (f:File) REQUIRE (f.fileId, f.orgId) IS UNIQUE",
      );

      await tx.run(
        "CREATE CONSTRAINT embeddingChunk_chunkId_orgId IF NOT EXISTS FOR (c:EmbeddingChunk) REQUIRE (c.chunkId, c.orgId) IS UNIQUE",
      );

      await tx.run(
        "CREATE CONSTRAINT aiLog_logId_orgId IF NOT EXISTS FOR (l:AIExecutionLog) REQUIRE (l.logId, l.orgId) IS UNIQUE",
      );

      await tx.run(
        "CREATE CONSTRAINT processingLog_logId_orgId IF NOT EXISTS FOR (l:ProcessingLog) REQUIRE (l.logId, l.orgId) IS UNIQUE",
      );

      await tx.run(
        "CREATE CONSTRAINT typeRegistry_typeName_orgId IF NOT EXISTS FOR (t:TypeRegistry) REQUIRE (t.typeName, t.orgId) IS UNIQUE",
      );
    });

    // Vector index for semantic search (best-effort).
    // Note: requires Neo4j version with VECTOR INDEX support.
    // Dimension is set to 1536 as a safe default; adjust later if needed.
    try {
      await session.executeWrite(async (tx) => {
        await tx.run(`
CREATE VECTOR INDEX embeddingChunk_vector IF NOT EXISTS
FOR (c:EmbeddingChunk) ON (c.vector)
OPTIONS { indexConfig: { \`vector.dimensions\`: 1536, \`vector.similarity_function\`: 'cosine' } }
        `);
      });
    } catch {
      // Ignore if running on Neo4j without vector index support.
    }
  } finally {
    await session.close();
  }
}

