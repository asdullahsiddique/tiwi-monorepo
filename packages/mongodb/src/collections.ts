import { F1_COLL } from "./f1Documents";

/** MongoDB collection names */
export const COLL = {
  organizations: "organizations",
  users: "users",
  files: "files",
  processingLogs: "processing_logs",
  aiExecutionLogs: "ai_execution_logs",
  embeddingChunks: "embedding_chunks",
  searchHistory: "search_history",
  customPrompts: "custom_prompts",
  fileProcessingJobs: "file_processing_jobs",
  // F1 entity collections (16 typed collections)
  ...F1_COLL,
} as const;
