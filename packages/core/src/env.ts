import { z } from "zod";

const CoreEnvSchema = z.object({
  MONGODB_URI: z.string().min(1),
  PINECONE_API_KEY: z.string().min(1),
  PINECONE_INDEX: z.string().min(1),
});

export type CoreEnv = z.infer<typeof CoreEnvSchema>;

export function getCoreEnv(env: NodeJS.ProcessEnv = process.env): CoreEnv {
  return CoreEnvSchema.parse(env);
}
