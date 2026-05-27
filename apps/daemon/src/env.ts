import { z } from "zod";

const DaemonEnvSchema = z.object({
  MONGODB_URI: z.string().min(1).default("mongodb://localhost:27017/tiwi"),

  // Anthropic (required by the unified document extraction flow at runtime)
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_AGENT_MODEL: z.string().min(1).default("claude-opus-4-7"),
  CLAUDE_AGENT_MAX_TURNS: z.coerce.number().int().positive().default(200),
  CLAUDE_SUMMARY_MODEL: z.string().min(1).default("claude-haiku-4-5"),
  ANTHROPIC_CLAUDE_OPUS_INPUT_USD_PER_1M: z.coerce.number().nonnegative().default(15),
  ANTHROPIC_CLAUDE_OPUS_OUTPUT_USD_PER_1M: z.coerce.number().nonnegative().default(75),
  ANTHROPIC_CLAUDE_SONNET_INPUT_USD_PER_1M: z.coerce.number().nonnegative().default(3),
  ANTHROPIC_CLAUDE_SONNET_OUTPUT_USD_PER_1M: z.coerce.number().nonnegative().default(15),
  ANTHROPIC_CLAUDE_HAIKU_INPUT_USD_PER_1M: z.coerce.number().nonnegative().default(1),
  ANTHROPIC_CLAUDE_HAIKU_OUTPUT_USD_PER_1M: z.coerce.number().nonnegative().default(5),

  // AssemblyAI (optional - for video/audio transcription)
  ASSEMBLYAI_API_KEY: z.string().optional(),

  // Agent query inbox (chat /agent-search)
  // Resolved to <daemonRoot>/tiwi-testing when unset; override for staging/prod.
  TIWI_CORPUS_DIR: z.string().optional(),
  AGENT_QUERY_MAX_TURNS: z.coerce.number().int().positive().default(60),

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
