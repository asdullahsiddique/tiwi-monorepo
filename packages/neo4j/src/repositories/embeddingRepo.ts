import type { Driver } from "neo4j-driver";

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
  constructor(private readonly driver: Driver) {}

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
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite(async (tx) => {
        await tx.run(
          `
MATCH (f:File {orgId: $orgId, fileId: $fileId})
MERGE (c:EmbeddingChunk {orgId: $orgId, chunkId: $chunkId})
  ON CREATE SET c.createdAt = datetime($createdAtIso)
SET
  c.fileId = $fileId,
  c.index = $index,
  c.text = $text,
  c.model = $model,
  c.vector = $vector
MERGE (f)-[:HAS_EMBEDDING_CHUNK]->(c)
          `,
          params,
        );
      });
    } finally {
      await session.close();
    }
  }

  async getEmbeddingsMeta(params: { orgId: string; fileId: string }): Promise<EmbeddingsMeta> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (:File {orgId: $orgId, fileId: $fileId})-[:HAS_EMBEDDING_CHUNK]->(c:EmbeddingChunk)
RETURN count(c) AS chunkCount, head(collect(distinct c.model)) AS model
          `,
          params,
        ),
      );

      const record = res.records[0];
      if (!record) return { chunkCount: 0 };
      return {
        chunkCount: record.get("chunkCount") ?? 0,
        model: record.get("model") ?? undefined,
      };
    } finally {
      await session.close();
    }
  }

  async querySimilarChunks(params: {
    orgId: string;
    vector: number[];
    topK: number;
  }): Promise<SimilarChunk[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.executeRead((tx) =>
        tx.run(
          `
CALL db.index.vector.queryNodes('embeddingChunk_vector', $topK, $vector)
YIELD node, score
WHERE node.orgId = $orgId
RETURN node, score
ORDER BY score DESC
          `,
          params,
        ),
      );

      return res.records.map((r) => {
        const node = r.get("node");
        const p = node.properties as any;
        return {
          chunkId: p.chunkId,
          fileId: p.fileId,
          index: p.index ?? 0,
          text: p.text ?? "",
          model: p.model ?? "",
          score: r.get("score") ?? 0,
        };
      });
    } finally {
      await session.close();
    }
  }
}

