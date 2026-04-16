import type { Db } from "mongodb";
import { COLL } from "../collections";
import { pineconeDeleteByFile, pineconeQuerySimilar, pineconeUpsertVectors } from "../pinecone";

export type EmbeddingsMeta = {
  chunkCount: number;
  model?: string;
};

export type SimilarChunk = {
  chunkId: string;
  fileId: string;
  index: number;
  text: string;
  model: string;
  score: number;
};

export class EmbeddingRepository {
  constructor(
    private readonly db: Db,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * Remove all chunks for a file (Mongo + Pinecone) before re-embedding.
   */
  async deleteChunksForFile(params: { orgId: string; fileId: string }): Promise<void> {
    await pineconeDeleteByFile(params, this.env);
    await this.db.collection(COLL.embeddingChunks).deleteMany({
      orgId: params.orgId,
      fileId: params.fileId,
    });
  }

  async upsertEmbeddingChunk(params: {
    orgId: string;
    fileId: string;
    chunkId: string;
    index: number;
    text: string;
    model: string;
    createdAtIso: string;
    vector: number[];
  }): Promise<void> {
    const createdAt = new Date(params.createdAtIso);
    await this.db.collection(COLL.embeddingChunks).updateOne(
      { orgId: params.orgId, chunkId: params.chunkId },
      {
        $set: {
          orgId: params.orgId,
          fileId: params.fileId,
          chunkId: params.chunkId,
          index: params.index,
          text: params.text,
          model: params.model,
          createdAt,
        },
      },
      { upsert: true },
    );

    await pineconeUpsertVectors(
      [
        {
          id: params.chunkId,
          values: params.vector,
          metadata: {
            orgId: params.orgId,
            fileId: params.fileId,
            chunkIndex: params.index,
          },
        },
      ],
      this.env,
    );
  }

  async getEmbeddingsMeta(params: { orgId: string; fileId: string }): Promise<EmbeddingsMeta> {
    const agg = await this.db
      .collection(COLL.embeddingChunks)
      .aggregate<{ chunkCount: number; model?: string }>([
        { $match: { orgId: params.orgId, fileId: params.fileId } },
        {
          $group: {
            _id: null,
            chunkCount: { $sum: 1 },
            model: { $first: "$model" },
          },
        },
      ])
      .toArray();

    const row = agg[0];
    if (!row) return { chunkCount: 0 };
    return { chunkCount: row.chunkCount, model: row.model };
  }

  async querySimilarChunks(params: {
    orgId: string;
    vector: number[];
    topK: number;
  }): Promise<SimilarChunk[]> {
    const matches = await pineconeQuerySimilar({
      vector: params.vector,
      topK: params.topK,
      orgId: params.orgId,
      env: this.env,
    });

    if (matches.length === 0) return [];

    const chunkIds = matches.map((m) => m.id).filter(Boolean);
    const docs = await this.db
      .collection(COLL.embeddingChunks)
      .find({
        orgId: params.orgId,
        chunkId: { $in: chunkIds },
      })
      .toArray();

    const byId = new Map(
      docs.map((d) => [String((d as unknown as { chunkId: string }).chunkId), d]),
    );

    return matches
      .map((m) => {
        const doc = byId.get(m.id) as
          | {
              chunkId: string;
              fileId: string;
              index: number;
              text: string;
              model: string;
            }
          | undefined;
        if (!doc) {
          return null;
        }
        return {
          chunkId: doc.chunkId,
          fileId: doc.fileId,
          index: doc.index ?? 0,
          text: doc.text ?? "",
          model: doc.model ?? "",
          score: m.score,
        };
      })
      .filter((x): x is SimilarChunk => x !== null);
  }
}
