import type { Db } from "mongodb";

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
  constructor(private readonly db: Db) {}

  /**
   * @deprecated Embeddings were removed from the v1 daemon pipeline.
   */
  async deleteChunksForFile(_params: { orgId: string; fileId: string }): Promise<void> {
    void this.db;
  }

  /**
   * @deprecated Embeddings were removed from the v1 daemon pipeline.
   */
  async upsertEmbeddingChunk(_params: {
    orgId: string;
    fileId: string;
    chunkId: string;
    index: number;
    text: string;
    model: string;
    createdAtIso: string;
    vector: number[];
  }): Promise<void> {
    void this.db;
  }

  /**
   * @deprecated Use file extracted text metadata instead.
   */
  async getEmbeddingsMeta(_params: { orgId: string; fileId: string }): Promise<EmbeddingsMeta> {
    void this.db;
    return { chunkCount: 0 };
  }

  /**
   * @deprecated Use Mongo text search over files.extractedText instead.
   */
  async querySimilarChunks(_params: {
    orgId: string;
    vector: number[];
    topK: number;
  }): Promise<SimilarChunk[]> {
    void this.db;
    return [];
  }
}
