import neo4j, { Driver } from "neo4j-driver";
import { getNeo4jEnv } from "./env";

export function createNeo4jDriver(env: NodeJS.ProcessEnv = process.env): Driver {
  const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = getNeo4jEnv(env);
  return neo4j.driver(
    NEO4J_URI,
    neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD),
    {
      disableLosslessIntegers: true,
    },
  );
}

