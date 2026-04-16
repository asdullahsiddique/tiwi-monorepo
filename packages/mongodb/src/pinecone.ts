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

export async function pineconeDeleteByFile(
  params: { orgId: string; fileId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const index = getIndex(env);
  await index.deleteMany({
    filter: {
      orgId: { $eq: params.orgId },
      fileId: { $eq: params.fileId },
    },
  });
}
