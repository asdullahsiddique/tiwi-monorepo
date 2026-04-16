import type { Db } from "mongodb";
import { COLL } from "../collections";

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

function toIso(d: unknown): string {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string") return d;
  return "";
}

export class LogRepository {
  constructor(private readonly db: Db) {}

  async appendProcessingLog(params: {
    orgId: string;
    fileId: string;
    logId: string;
    level: "DEBUG" | "INFO" | "WARN" | "ERROR";
    message: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const file = await this.db.collection(COLL.files).findOne({
      orgId: params.orgId,
      fileId: params.fileId,
    });
    if (!file) return;

    await this.db.collection(COLL.processingLogs).insertOne({
      orgId: params.orgId,
      fileId: params.fileId,
      logId: params.logId,
      level: params.level,
      message: params.message,
      metadata: params.metadata ?? null,
      createdAt: new Date(),
    });
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
    await this.db.collection(COLL.aiExecutionLogs).insertOne({
      orgId: params.orgId,
      fileId: params.fileId ?? null,
      logId: params.logId,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      totalTokens: params.totalTokens,
      costUsd: params.costUsd,
      purpose: params.purpose,
      metadata: params.metadata ?? null,
      createdAt: new Date(),
    });
  }

  async listProcessingLogs(params: {
    orgId: string;
    fileId: string;
    limit: number;
    offset: number;
  }): Promise<ProcessingLogRecord[]> {
    const docs = await this.db
      .collection(COLL.processingLogs)
      .find({ orgId: params.orgId, fileId: params.fileId })
      .sort({ createdAt: -1 })
      .skip(params.offset)
      .limit(params.limit)
      .toArray();

    return docs.map((d) => {
      const x = d as Record<string, unknown>;
      return {
        logId: String(x.logId),
        level: x.level as ProcessingLogRecord["level"],
        message: String(x.message),
        createdAt: toIso(x.createdAt),
        metadata:
          x.metadata && typeof x.metadata === "object" && !Array.isArray(x.metadata)
            ? (x.metadata as Record<string, unknown>)
            : typeof x.metadata === "string"
              ? (JSON.parse(x.metadata as string) as Record<string, unknown>)
              : undefined,
      };
    });
  }

  async listAIExecutionLogs(params: {
    orgId: string;
    fileId: string;
    limit: number;
    offset: number;
  }): Promise<AIExecutionLogRecord[]> {
    const docs = await this.db
      .collection(COLL.aiExecutionLogs)
      .find({ orgId: params.orgId, fileId: params.fileId })
      .sort({ createdAt: -1 })
      .skip(params.offset)
      .limit(params.limit)
      .toArray();

    return docs.map((d) => {
      const x = d as Record<string, unknown>;
      return {
        logId: String(x.logId),
        model: String(x.model),
        inputTokens: Number(x.inputTokens ?? 0),
        outputTokens: Number(x.outputTokens ?? 0),
        totalTokens: Number(x.totalTokens ?? 0),
        costUsd: Number(x.costUsd ?? 0),
        purpose: String(x.purpose),
        createdAt: toIso(x.createdAt),
        metadata:
          x.metadata && typeof x.metadata === "object" && !Array.isArray(x.metadata)
            ? (x.metadata as Record<string, unknown>)
            : typeof x.metadata === "string"
              ? (JSON.parse(x.metadata as string) as Record<string, unknown>)
              : undefined,
      };
    });
  }
}
