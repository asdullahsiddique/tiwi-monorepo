import { z } from "zod";

const CoreEnvSchema = z.object({
  REDIS_URL: z.string().min(1),
});

export type CoreEnv = z.infer<typeof CoreEnvSchema>;

export function getCoreEnv(env: NodeJS.ProcessEnv = process.env): CoreEnv {
  return CoreEnvSchema.parse(env);
}

