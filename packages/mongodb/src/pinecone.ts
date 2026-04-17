import { Pinecone } from "@pinecone-database/pinecone";
import { getPineconeEnv } from "./env";

const globalForPinecone = globalThis as unknown as {
  pineconeIndex?: ReturnType<Pinecone["index"]>;
};

function getIndex(env: NodeJS.ProcessEnv = process.env) {
  if (!globalForPinecone.pineconeIndex) {
    const { PINECONE_API_KEY, PINECONE_INDEX } = getPineconeEnv(env);
    const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
    globalForPinecone.pineconeIndex = pc.index(PINECONE_INDEX);
  }
  return globalForPinecone.pineconeIndex;
}

export async function pineconeUpsertVectors(
  vectors: Array<{
    id: string;
    values: number[];
    metadata: { orgId: string; fileId: string; chunkIndex: number };
  }>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (vectors.length === 0) return;
  const index = getIndex(env);
  await index.upsert(vectors);
}

export async function pineconeQuerySimilar(params: {
  vector: number[];
  topK: number;
  orgId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Array<{ id: string; score: number; metadata?: Record<string, unknown> }>> {
  const index = getIndex(params.env);
  const res = await index.query({
    vector: params.vector,
    topK: params.topK,
    includeMetadata: true,
    filter: { orgId: { $eq: params.orgId } },
  });
  return (res.matches ?? []).map((m) => ({
    id: m.id ?? "",
    score: m.score ?? 0,
    metadata: (m.metadata as Record<string, unknown>) ?? undefined,
  }));
}

/**
 * Delete all vectors for a given file.
 *
 * Serverless Pinecone indexes (host pattern `*.svc.aped-*.pinecone.io`) do NOT
 * support `deleteMany({ filter })` — that returns 404. They DO support listing
 * IDs by prefix and deleting by IDs, which is the pattern used here.
 *
 * Chunk IDs are formatted as `${fileId}:${chunkIndex}` in `embeddingRepo`, so
 * we can list by prefix `${fileId}:` and delete the resulting IDs in batches
 * (Pinecone caps deleteMany(ids) at 1000 IDs per call).
 */
export async function pineconeDeleteByFile(
  params: { orgId: string; fileId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const index = getIndex(env);
  const prefix = `${params.fileId}:`;
  const BATCH = 1000;

  let paginationToken: string | undefined;
  do {
    const page = await index.listPaginated({
      prefix,
      paginationToken,
    });
    const ids = (page.vectors ?? [])
      .map((v) => v.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      if (slice.length === 0) continue;
      await index.deleteMany(slice);
    }

    paginationToken = page.pagination?.next ?? undefined;
  } while (paginationToken);
}
