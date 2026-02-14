import { z } from "zod";

const LangGraphEnvSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_ENRICHMENT_MODEL: z.string().min(1).default("gpt-4o-mini"),
  OPENAI_PRICE_INPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0),
  OPENAI_PRICE_OUTPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0),
});

export type LangGraphEnv = z.infer<typeof LangGraphEnvSchema>;

export function getLangGraphEnv(env: NodeJS.ProcessEnv = process.env): LangGraphEnv {
  return LangGraphEnvSchema.parse(env);
}

