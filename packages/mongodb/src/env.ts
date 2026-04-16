import { z } from "zod";

const MongoEnvSchema = z.object({
  MONGODB_URI: z.string().min(1),
});

export type MongoEnv = z.infer<typeof MongoEnvSchema>;

export function getMongoEnv(env: NodeJS.ProcessEnv = process.env): MongoEnv {
  return MongoEnvSchema.parse(env);
}

const PineconeEnvSchema = z.object({
  PINECONE_API_KEY: z.string().min(1),
  PINECONE_INDEX: z.string().min(1),
});

export type PineconeEnv = z.infer<typeof PineconeEnvSchema>;

export function getPineconeEnv(env: NodeJS.ProcessEnv = process.env): PineconeEnv {
  return PineconeEnvSchema.parse(env);
}
