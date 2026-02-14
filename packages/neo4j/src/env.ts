import { z } from "zod";

const Neo4jEnvSchema = z.object({
  NEO4J_URI: z.string().min(1),
  NEO4J_USERNAME: z.string().min(1),
  NEO4J_PASSWORD: z.string().min(1),
});

export type Neo4jEnv = z.infer<typeof Neo4jEnvSchema>;

export function getNeo4jEnv(env: NodeJS.ProcessEnv = process.env): Neo4jEnv {
  return Neo4jEnvSchema.parse(env);
}

