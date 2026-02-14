import type { Driver } from "neo4j-driver";

/**
 * Minimal schema bootstrap for v1.
 * Safe to run on every startup (IF NOT EXISTS).
 */
export async function ensureNeo4jSchema(driver: Driver): Promise<void> {
  const session = driver.session({ defaultAccessMode: "WRITE" });
  try {
    // Create constraints one-by-one so one failure doesn't block the whole app.
    // This is especially useful for local dev where old volumes may contain duplicates.
    const constraintStatements = [
      "CREATE CONSTRAINT org_orgId IF NOT EXISTS FOR (o:Organization) REQUIRE o.orgId IS UNIQUE",
      "CREATE CONSTRAINT user_userId_orgId IF NOT EXISTS FOR (u:User) REQUIRE (u.userId, u.orgId) IS UNIQUE",
      "CREATE CONSTRAINT file_fileId_orgId IF NOT EXISTS FOR (f:File) REQUIRE (f.fileId, f.orgId) IS UNIQUE",
      "CREATE CONSTRAINT embeddingChunk_chunkId_orgId IF NOT EXISTS FOR (c:EmbeddingChunk) REQUIRE (c.chunkId, c.orgId) IS UNIQUE",
      "CREATE CONSTRAINT aiLog_logId_orgId IF NOT EXISTS FOR (l:AIExecutionLog) REQUIRE (l.logId, l.orgId) IS UNIQUE",
      "CREATE CONSTRAINT processingLog_logId_orgId IF NOT EXISTS FOR (l:ProcessingLog) REQUIRE (l.logId, l.orgId) IS UNIQUE",
      "CREATE CONSTRAINT typeRegistry_typeName_orgId IF NOT EXISTS FOR (t:TypeRegistry) REQUIRE (t.typeName, t.orgId) IS UNIQUE",
      // Entity constraints and indexes for context-aware knowledge graph
      "CREATE CONSTRAINT entity_unique IF NOT EXISTS FOR (e:Entity) REQUIRE (e.orgId, e.typeName, e.nameLower) IS UNIQUE",
      "CREATE INDEX entity_orgId IF NOT EXISTS FOR (e:Entity) ON (e.orgId)",
      "CREATE INDEX entity_typeName IF NOT EXISTS FOR (e:Entity) ON (e.orgId, e.typeName)",
      "CREATE INDEX entity_entityId IF NOT EXISTS FOR (e:Entity) ON (e.orgId, e.entityId)",
    ];

    for (const statement of constraintStatements) {
      try {
        await session.executeWrite((tx) => tx.run(statement));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);

        // Best-effort dev repair: if old dev data has duplicate File nodes, dedupe and retry once.
        if (
          statement.includes("file_fileId_orgId") &&
          msg.includes("already exists with label")
        ) {
          try {
            await session.executeWrite((tx) =>
              tx.run(`
MATCH (f:File)
WITH f.orgId AS orgId, f.fileId AS fileId, collect(f) AS fs
WHERE orgId IS NOT NULL AND fileId IS NOT NULL AND size(fs) > 1
CALL {
  WITH fs
  UNWIND fs AS n
  RETURN id(n) AS keepId
  ORDER BY n.updatedAt DESC, keepId DESC
  LIMIT 1
}
WITH fs, keepId
UNWIND fs AS n
WITH n, keepId
WHERE id(n) <> keepId
DETACH DELETE n
              `),
            );

            await session.executeWrite((tx) => tx.run(statement));
          } catch {
            // Ignore; app can still run without this constraint in local dev.
          }
        }

        // Ignore constraint failures to avoid breaking UI/dev.
      }
    }

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
