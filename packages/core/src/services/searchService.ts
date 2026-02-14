import OpenAI from "openai";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  getNeo4jDriver,
  EmbeddingRepository,
  ensureNeo4jSchema,
  FileRepository,
  LogRepository,
  EntityRepository,
  type SimilarChunk,
  type EntityRecord,
  type RelationshipRecord,
} from "@tiwi/neo4j";

const SearchEnvSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  OPENAI_SEARCH_MODEL: z.string().min(1).default("gpt-4o-mini"),
  OPENAI_PRICE_INPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0),
  OPENAI_PRICE_OUTPUT_PER_1M_USD: z.coerce.number().nonnegative().default(0),
});

function getSearchEnv(env: NodeJS.ProcessEnv = process.env) {
  return SearchEnvSchema.parse(env);
}

function estimateCostUsd(params: {
  inputTokens: number;
  outputTokens: number;
  priceInputPer1M: number;
  priceOutputPer1M: number;
}): number {
  const input = (params.inputTokens / 1_000_000) * params.priceInputPer1M;
  const output = (params.outputTokens / 1_000_000) * params.priceOutputPer1M;
  return Number((input + output).toFixed(6));
}

export type SearchCitation = {
  fileId: string;
  chunkId: string;
  score: number;
  snippet: string;
};

export type EntityMatch = {
  entityId: string;
  typeName: string;
  name: string;
  relevanceScore: number;
};

export type SemanticSearchResult = {
  answer: string;
  citations: SearchCitation[];
  chunks: SimilarChunk[];
  relatedFiles: Array<{
    fileId: string;
    originalName: string;
    contentType: string;
  }>;
  // Graph-enhanced context
  matchedEntities: EntityMatch[];
  graphContext: string;
};

/**
 * Parse query to identify potential entity references.
 * Returns tokens that might match entity names.
 */
async function parseQueryForEntities(params: {
  query: string;
  entityRepo: EntityRepository;
  orgId: string;
}): Promise<EntityMatch[]> {
  // Get all entities for fuzzy matching
  const entities = await params.entityRepo.getEntitiesSummary({
    orgId: params.orgId,
    limit: 500,
  });

  const queryLower = params.query.toLowerCase();
  const matches: EntityMatch[] = [];

  for (const entity of entities) {
    const nameLower = entity.name.toLowerCase();
    // Simple fuzzy match: check if entity name appears in query or vice versa
    if (
      queryLower.includes(nameLower) ||
      nameLower.includes(queryLower.split(" ")[0] ?? "") // First word match
    ) {
      matches.push({
        entityId: entity.entityId,
        typeName: entity.typeName,
        name: entity.name,
        relevanceScore: queryLower.includes(nameLower) ? 1.0 : 0.5,
      });
    }
  }

  // Sort by relevance and return top matches
  return matches.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 10);
}

/**
 * Build graph context string from matched entities.
 */
async function buildGraphContext(params: {
  entityRepo: EntityRepository;
  orgId: string;
  matchedEntities: EntityMatch[];
}): Promise<string> {
  if (params.matchedEntities.length === 0) {
    return "";
  }

  const lines: string[] = ["=== KNOWLEDGE GRAPH CONTEXT ==="];

  for (const match of params.matchedEntities.slice(0, 5)) {
    // Get related entities for each match
    const related = await params.entityRepo.getRelatedEntities({
      orgId: params.orgId,
      entityId: match.entityId,
      depth: 2,
    });

    lines.push(`\nEntity: ${match.name} (${match.typeName})`);
    
    if (related.entities.length > 0) {
      lines.push("  Related entities:");
      for (const rel of related.entities.slice(0, 5)) {
        lines.push(`  - ${rel.name} (${rel.typeName})`);
      }
    }
  }

  return lines.join("\n");
}

export async function semanticSearch(params: {
  orgId: string;
  query: string;
  topK?: number;
}): Promise<SemanticSearchResult> {
  const env = getSearchEnv();
  const driver = getNeo4jDriver();
  const nowIso = new Date().toISOString();

  await ensureNeo4jSchema(driver);
  const embeddingRepo = new EmbeddingRepository(driver);
  const fileRepo = new FileRepository(driver);
  const logRepo = new LogRepository(driver);
  const entityRepo = new EntityRepository(driver);

  if (!env.OPENAI_API_KEY) {
    return {
      answer:
        "OPENAI_API_KEY is not configured. Semantic search requires embeddings + an LLM answer step.",
      citations: [],
      chunks: [],
      relatedFiles: [],
      matchedEntities: [],
      graphContext: "",
    };
  }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  // Parse query for entity matches
  const matchedEntities = await parseQueryForEntities({
    query: params.query,
    entityRepo,
    orgId: params.orgId,
  });

  // Build graph context from matched entities
  const graphContext = await buildGraphContext({
    entityRepo,
    orgId: params.orgId,
    matchedEntities,
  });

  const embedding = await client.embeddings.create({
    model: env.OPENAI_EMBEDDING_MODEL,
    input: params.query,
  });

  const vector = embedding.data[0]?.embedding ?? [];
  const chunks = await embeddingRepo.querySimilarChunks({
    orgId: params.orgId,
    vector,
    topK: params.topK ?? 8,
  });

  const relatedFiles = await fileRepo.getFilesByIds({
    orgId: params.orgId,
    fileIds: Array.from(new Set(chunks.map((c) => c.fileId))),
  });

  const context = chunks
    .slice(0, 8)
    .map(
      (c, i) =>
        `# Chunk ${i + 1} (fileId=${c.fileId}, chunkId=${c.chunkId}, score=${c.score})\n${c.text}`,
    )
    .join("\n\n");

  const structuralContext = relatedFiles
    .map(
      (f) =>
        `- fileId=${f.fileId} name="${f.originalName}" type=${f.contentType} status=${f.status}`,
    )
    .join("\n");

  // Include graph context in the prompt if we have entity matches
  const fullContext = graphContext
    ? `${graphContext}\n\n=== DOCUMENT CHUNKS ===\n${context}`
    : context;

  const completion = await client.chat.completions.create({
    model: env.OPENAI_SEARCH_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You answer user queries using provided context which may include knowledge graph entities and document chunks. Use the graph context to understand relationships between entities. Be concise and cite the relevant chunk IDs when referencing specific documents.",
      },
      {
        role: "user",
        content: `Query: ${params.query}\n\nFiles (graph expansion from top chunks):\n${structuralContext}\n\n${fullContext}`,
      },
    ],
  });

  const answer =
    completion.choices[0]?.message?.content ?? "No answer generated.";

  const inputTokens = completion.usage?.prompt_tokens ?? 0;
  const outputTokens = completion.usage?.completion_tokens ?? 0;
  const totalTokens =
    completion.usage?.total_tokens ?? inputTokens + outputTokens;
  const costUsd = estimateCostUsd({
    inputTokens,
    outputTokens,
    priceInputPer1M: env.OPENAI_PRICE_INPUT_PER_1M_USD,
    priceOutputPer1M: env.OPENAI_PRICE_OUTPUT_PER_1M_USD,
  });

  await logRepo.appendAIExecutionLog({
    orgId: params.orgId,
    logId: nanoid(),
    model: env.OPENAI_SEARCH_MODEL,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    purpose: "search:semantic_answer",
    metadata: {
      createdAtIso: nowIso,
      topK: params.topK ?? 8,
      matchedEntities: matchedEntities.length,
    },
  });

  const citations: SearchCitation[] = chunks.map((c) => ({
    fileId: c.fileId,
    chunkId: c.chunkId,
    score: c.score,
    snippet: c.text.slice(0, 200),
  }));

  return {
    answer,
    citations,
    chunks,
    relatedFiles: relatedFiles.map((f) => ({
      fileId: f.fileId,
      originalName: f.originalName,
      contentType: f.contentType,
    })),
    matchedEntities,
    graphContext,
  };
}
