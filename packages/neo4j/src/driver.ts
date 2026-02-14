import neo4j, { Driver } from "neo4j-driver";
import { getNeo4jEnv } from "./env";

/**
 * Global singleton driver stored in globalThis to survive HMR and serverless cold starts.
 * This prevents "Pool is closed" errors in Next.js edge/serverless environments.
 */
const globalForNeo4j = globalThis as unknown as {
  neo4jDriver: Driver | undefined;
};

export function createNeo4jDriver(
  env: NodeJS.ProcessEnv = process.env,
): Driver {
  const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = getNeo4jEnv(env);
  return neo4j.driver(
    NEO4J_URI,
    neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD),
    {
      disableLosslessIntegers: true,
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 30000,
    },
  );
}

/**
 * Returns a singleton Neo4j driver instance.
 * Safe for serverless/edge environments (Next.js API routes, tRPC, etc.)
 */
export function getNeo4jDriver(env: NodeJS.ProcessEnv = process.env): Driver {
  if (!globalForNeo4j.neo4jDriver) {
    globalForNeo4j.neo4jDriver = createNeo4jDriver(env);
  }
  return globalForNeo4j.neo4jDriver;
}

/**
 * Closes the singleton driver (call on graceful shutdown).
 */
export async function closeNeo4jDriver(): Promise<void> {
  if (globalForNeo4j.neo4jDriver) {
    await globalForNeo4j.neo4jDriver.close();
    globalForNeo4j.neo4jDriver = undefined;
  }
}
