import { z } from "zod";

const DaemonEnvSchema = z.object({
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  OPENAI_SUMMARIZATION_MODEL: z.string().min(1).default("gpt-4o-mini"),
  OPENAI_PRICE_INPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0),
  OPENAI_PRICE_OUTPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0),
});

export type DaemonEnv = z.infer<typeof DaemonEnvSchema>;

export function getDaemonEnv(env: NodeJS.ProcessEnv = process.env): DaemonEnv {
  return DaemonEnvSchema.parse(env);
}
