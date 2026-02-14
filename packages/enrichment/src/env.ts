import { z } from "zod";

const LangGraphEnvSchema = z.object({
  // OpenAI
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_ENRICHMENT_MODEL: z.string().min(1).default("gpt-4o-mini"),
  OPENAI_PRICE_INPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0),
  OPENAI_PRICE_OUTPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0),
  
  // LangSmith (optional - for observability)
  // Supports both LANGSMITH_* (newer) and LANGCHAIN_* (older) naming
  LANGSMITH_TRACING: z.string().optional(),
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),
  // Legacy naming (fallback)
  LANGCHAIN_TRACING_V2: z.string().optional(),
  LANGCHAIN_API_KEY: z.string().optional(),
  LANGCHAIN_PROJECT: z.string().optional(),
});

export type LangGraphEnv = z.infer<typeof LangGraphEnvSchema>;

export function getLangGraphEnv(env: NodeJS.ProcessEnv = process.env): LangGraphEnv {
  return LangGraphEnvSchema.parse(env);
}

/**
 * Configure LangSmith tracing if enabled.
 * Call this once at startup (e.g., in daemon worker initialization).
 * Supports both LANGSMITH_* (newer) and LANGCHAIN_* (older) naming conventions.
 */
export function configureLangSmith(env: LangGraphEnv = getLangGraphEnv()): void {
  // Check for newer LANGSMITH_* naming first, then fallback to LANGCHAIN_*
  const tracingEnabled = env.LANGSMITH_TRACING === "true" || env.LANGCHAIN_TRACING_V2 === "true";
  const apiKey = env.LANGSMITH_API_KEY ?? env.LANGCHAIN_API_KEY;
  const project = env.LANGSMITH_PROJECT ?? env.LANGCHAIN_PROJECT ?? "tiwi-enrichment";
  const endpoint = env.LANGSMITH_ENDPOINT;

  if (tracingEnabled && apiKey) {
    // LangChain SDK picks up these env vars automatically
    process.env.LANGCHAIN_TRACING_V2 = "true";
    process.env.LANGCHAIN_API_KEY = apiKey;
    process.env.LANGCHAIN_PROJECT = project;
    
    // Set endpoint if provided (for EU or other regions)
    if (endpoint) {
      process.env.LANGCHAIN_ENDPOINT = endpoint;
    }
    
    console.log(`[LangSmith] Tracing enabled for project: ${project}${endpoint ? ` (endpoint: ${endpoint})` : ""}`);
  }
}

