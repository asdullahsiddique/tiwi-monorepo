import { z } from "zod";

const DaemonEnvSchema = z.object({
  MONGODB_URI: z.string().min(1).default("mongodb://localhost:27017/tiwi"),
  PINECONE_API_KEY: z.string().min(1),
  PINECONE_INDEX: z.string().min(1),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  OPENAI_SUMMARIZATION_MODEL: z.string().min(1).default("gpt-5-mini"),
  OPENAI_PRICE_INPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0),
  OPENAI_PRICE_OUTPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0),

  // Anthropic (optional - for document-specific extraction flows)
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_AGENT_MODEL: z.string().min(1).default("claude-opus-4-7"),
  CLAUDE_AGENT_MAX_TURNS: z.coerce.number().int().positive().default(200),
  ANTHROPIC_CLAUDE_OPUS_INPUT_USD_PER_1M: z.coerce.number().nonnegative().default(15),
  ANTHROPIC_CLAUDE_OPUS_OUTPUT_USD_PER_1M: z.coerce.number().nonnegative().default(75),
  ANTHROPIC_CLAUDE_SONNET_INPUT_USD_PER_1M: z.coerce.number().nonnegative().default(3),
  ANTHROPIC_CLAUDE_SONNET_OUTPUT_USD_PER_1M: z.coerce.number().nonnegative().default(15),

  // AssemblyAI (optional - for video/audio transcription)
  ASSEMBLYAI_API_KEY: z.string().optional(),

  // LangSmith (optional - for LangGraph observability)
  LANGSMITH_TRACING: z.string().optional(),
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),
});

export type DaemonEnv = z.infer<typeof DaemonEnvSchema>;

export function getDaemonEnv(env: NodeJS.ProcessEnv = process.env): DaemonEnv {
  return DaemonEnvSchema.parse(env);
}
