import type { Db, ObjectId } from "mongodb";
import { COLL } from "./collections";

export type AgentQueryEventType =
  | "tool_call"
  | "assistant_text"
  | "system"
  | "result";

export type AgentQueryEventLevel = "INFO" | "WARN" | "ERROR";

export type AgentQueryEvent = {
  eventId: string;
  ts: Date;
  level: AgentQueryEventLevel;
  type: AgentQueryEventType;
  /**
   * Human-friendly one-liner suitable for the Claude-style activity indicator
   * (e.g. "Reading Doppietta Ferrari nella Qualifying Race a Macao.pdf").
   */
  message: string;
  metadata?: Record<string, unknown>;
};

export type AgentQueryHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AgentQueryJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type AgentQueryJobDoc = {
  _id: ObjectId;
  jobId: string;
  orgId: string;
  userId: string;
  conversationId: string;
  prompt: string;
  history: AgentQueryHistoryMessage[];
  status: AgentQueryJobStatus;
  events: AgentQueryEvent[];
  responseMarkdown?: string;
  failureReason?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  createdAt: Date;
  updatedAt: Date;
  /** Set when status flips to "completed" or "failed". */
  finishedAt?: Date;
};

export type AgentQueryJobInsert = Omit<
  AgentQueryJobDoc,
  "_id" | "status" | "events" | "createdAt" | "updatedAt"
>;

export async function enqueueAgentQuery(
  db: Db,
  payload: AgentQueryJobInsert,
): Promise<void> {
  const now = new Date();
  await db.collection(COLL.agentQueryJobs).insertOne({
    ...payload,
    status: "queued",
    events: [],
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Atomically transitions a `queued` job to `running`. Returns the updated
 * document if claimed, otherwise null. Used by the daemon to ensure a job is
 * only ever processed once (even if both the change stream and the startup
 * drain see it).
 */
export async function claimAgentQuery(
  db: Db,
  jobId: string,
): Promise<AgentQueryJobDoc | null> {
  const res = (await db.collection(COLL.agentQueryJobs).findOneAndUpdate(
    { jobId, status: "queued" },
    { $set: { status: "running", updatedAt: new Date() } },
    { returnDocument: "after" },
  )) as unknown as AgentQueryJobDoc | { value: AgentQueryJobDoc | null } | null;

  if (!res) return null;
  if (typeof res === "object" && "value" in res) {
    return (res as { value: AgentQueryJobDoc | null }).value ?? null;
  }
  if (typeof res === "object" && "jobId" in res) {
    return res as AgentQueryJobDoc;
  }
  return null;
}

export async function appendAgentQueryEvent(
  db: Db,
  jobId: string,
  event: AgentQueryEvent,
): Promise<void> {
  await db.collection(COLL.agentQueryJobs).updateOne(
    { jobId },
    {
      $push: { events: event } as never,
      $set: { updatedAt: new Date() },
    },
  );
}

export async function completeAgentQuery(
  db: Db,
  jobId: string,
  params: {
    responseMarkdown: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
  },
): Promise<void> {
  const now = new Date();
  await db.collection(COLL.agentQueryJobs).updateOne(
    { jobId },
    {
      $set: {
        status: "completed",
        responseMarkdown: params.responseMarkdown,
        tokensIn: params.tokensIn,
        tokensOut: params.tokensOut,
        costUsd: params.costUsd,
        updatedAt: now,
        finishedAt: now,
      },
    },
  );
}

export async function failAgentQuery(
  db: Db,
  jobId: string,
  failureReason: string,
): Promise<void> {
  const now = new Date();
  await db.collection(COLL.agentQueryJobs).updateOne(
    { jobId },
    {
      $set: {
        status: "failed",
        failureReason,
        updatedAt: now,
        finishedAt: now,
      },
    },
  );
}

export async function getAgentQuery(
  db: Db,
  params: { orgId: string; jobId: string },
): Promise<AgentQueryJobDoc | null> {
  const doc = await db
    .collection(COLL.agentQueryJobs)
    .findOne({ orgId: params.orgId, jobId: params.jobId });
  return (doc as unknown as AgentQueryJobDoc | null) ?? null;
}

/**
 * Pulls every still-queued job, oldest first. Used at daemon startup to
 * catch any inserts that landed while the change stream was disconnected.
 */
export async function findQueuedAgentQueries(
  db: Db,
): Promise<AgentQueryJobDoc[]> {
  const docs = await db
    .collection(COLL.agentQueryJobs)
    .find({ status: "queued" })
    .sort({ createdAt: 1 })
    .toArray();
  return docs as unknown as AgentQueryJobDoc[];
}
