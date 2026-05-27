import { z } from "zod";

const MongoEnvSchema = z.object({
  MONGODB_URI: z.string().min(1),
});

export type MongoEnv = z.infer<typeof MongoEnvSchema>;

export function getMongoEnv(env: NodeJS.ProcessEnv = process.env): MongoEnv {
  return MongoEnvSchema.parse(env);
}

