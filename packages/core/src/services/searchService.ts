import OpenAI from "openai";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  getMongoDb,
  EmbeddingRepository,
  FileRepository,
  LogRepository,
  EntityRepository,
  type SimilarChunk,
} from "@tiwi/mongodb";

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
  matchedEntities: EntityMatch[];
  graphContext: string;
};

async function parseQueryForEntities(params: {
  query: string;
  entityRepo: EntityRepository;
  orgId: string;
}): Promise<EntityMatch[]> {
  const entities = await params.entityRepo.getEntitiesSummary({
    orgId: params.orgId,
    limit: 500,
  });

  const queryLower = params.query.toLowerCase();
  const matches: EntityMatch[] = [];

  for (const entity of entities) {
    const nameLower = entity.name.toLowerCase();
    if (
      queryLower.includes(nameLower) ||
      nameLower.includes(queryLower.split(" ")[0] ?? "")
    ) {
      matches.push({
        entityId: entity.entityId,
        typeName: entity.typeName,
        name: entity.name,
        relevanceScore: queryLower.includes(nameLower) ? 1.0 : 0.5,
      });
    }
  }

  return matches.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, 10);
}

/**
 * 1-hop entity context: related entities for matched names (lightweight vs Neo4j depth-2).
 */
async function buildGraphContext(params: {
  entityRepo: EntityRepository;
  orgId: string;
  matchedEntities: EntityMatch[];
}): Promise<string> {
  if (params.matchedEntities.length === 0) {
    return "";
  }

  const lines: string[] = ["=== ENTITY CONTEXT ==="];

  for (const match of params.matchedEntities.slice(0, 5)) {
    const related = await params.entityRepo.getRelatedEntities({
      orgId: params.orgId,
      entityId: match.entityId,
      typeName: match.typeName,
      depth: 1,
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
  const nowIso = new Date().toISOString();

  const db = await getMongoDb();
  const embeddingRepo = new EmbeddingRepository(db);
  const fileRepo = new FileRepository(db);
  const logRepo = new LogRepository(db);
  const entityRepo = new EntityRepository(db);

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

  const matchedEntities = await parseQueryForEntities({
    query: params.query,
    entityRepo,
    orgId: params.orgId,
  });

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
          "You answer user queries using provided context which may include entity summaries and document chunks. Be concise and cite the relevant chunk IDs when referencing specific documents.",
      },
      {
        role: "user",
        content: `Query: ${params.query}\n\nFiles (from top chunks):\n${structuralContext}\n\n${fullContext}`,
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
