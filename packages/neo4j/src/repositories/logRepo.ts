import type { Driver } from "neo4j-driver";

export type ProcessingLogRecord = {
  logId: string;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  message: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type AIExecutionLogRecord = {
  logId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  purpose: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export class LogRepository {
  constructor(private readonly driver: Driver) {}

  async appendProcessingLog(params: {
    orgId: string;
    fileId: string;
    logId: string;
    level: "DEBUG" | "INFO" | "WARN" | "ERROR";
    message: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite(async (tx) => {
        await tx.run(
          `
MATCH (f:File {orgId: $orgId, fileId: $fileId})
CREATE (l:ProcessingLog {
  orgId: $orgId,
  fileId: $fileId,
  logId: $logId,
  level: $level,
  message: $message,
  metadata: $metadata,
  createdAt: datetime()
})
MERGE (f)-[:HAS_PROCESSING_LOG]->(l)
          `,
          {
            ...params,
            metadata: params.metadata ?? null,
          },
        );
      });
    } finally {
      await session.close();
    }
  }

  async appendAIExecutionLog(params: {
    orgId: string;
    fileId?: string;
    logId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    purpose: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite(async (tx) => {
        await tx.run(
          `
CREATE (l:AIExecutionLog {
  orgId: $orgId,
  fileId: $fileId,
  logId: $logId,
  model: $model,
  inputTokens: $inputTokens,
  outputTokens: $outputTokens,
  totalTokens: $totalTokens,
  costUsd: $costUsd,
  purpose: $purpose,
  metadata: $metadata,
  createdAt: datetime()
})
WITH l
OPTIONAL MATCH (f:File {orgId: $orgId, fileId: $fileId})
FOREACH (_ IN CASE WHEN f IS NULL THEN [] ELSE [1] END |
  MERGE (f)-[:HAS_AI_LOG]->(l)
)
          `,
          { ...params, fileId: params.fileId ?? null, metadata: params.metadata ?? null },
        );
      });
    } finally {
      await session.close();
    }
  }

  async listProcessingLogs(params: {
    orgId: string;
    fileId: string;
    limit: number;
    offset: number;
  }): Promise<ProcessingLogRecord[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (:File {orgId: $orgId, fileId: $fileId})-[:HAS_PROCESSING_LOG]->(l:ProcessingLog)
RETURN l
ORDER BY l.createdAt DESC
SKIP $offset
LIMIT $limit
          `,
          params,
        ),
      );

      return res.records.map((r) => {
        const node = r.get("l");
        const p = node.properties as any;
        return {
          logId: p.logId,
          level: p.level,
          message: p.message,
          createdAt: p.createdAt?.toString?.() ?? String(p.createdAt),
          metadata: p.metadata ?? undefined,
        };
      });
    } finally {
      await session.close();
    }
  }

  async listAIExecutionLogs(params: {
    orgId: string;
    fileId: string;
    limit: number;
    offset: number;
  }): Promise<AIExecutionLogRecord[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (:File {orgId: $orgId, fileId: $fileId})-[:HAS_AI_LOG]->(l:AIExecutionLog)
RETURN l
ORDER BY l.createdAt DESC
SKIP $offset
LIMIT $limit
          `,
          params,
        ),
      );

      return res.records.map((r) => {
        const node = r.get("l");
        const p = node.properties as any;
        return {
          logId: p.logId,
          model: p.model,
          inputTokens: p.inputTokens ?? 0,
          outputTokens: p.outputTokens ?? 0,
          totalTokens: p.totalTokens ?? 0,
          costUsd: p.costUsd ?? 0,
          purpose: p.purpose,
          createdAt: p.createdAt?.toString?.() ?? String(p.createdAt),
          metadata: p.metadata ?? undefined,
        };
      });
    } finally {
      await session.close();
    }
  }
}

