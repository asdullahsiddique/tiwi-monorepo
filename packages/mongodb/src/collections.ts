/** MongoDB collection names */
export const COLL = {
  organizations: "organizations",
  users: "users",
  files: "files",
  processingLogs: "processing_logs",
  aiExecutionLogs: "ai_execution_logs",
  embeddingChunks: "embedding_chunks",
  entities: "entities",
  entityRelationships: "entity_relationships",
  typeRegistry: "type_registry",
  searchHistory: "search_history",
  fileProcessingJobs: "file_processing_jobs",
} as const;
