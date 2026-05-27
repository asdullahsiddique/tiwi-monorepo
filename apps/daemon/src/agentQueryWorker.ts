import {
  claimAgentQuery,
  findQueuedAgentQueries,
  getMongoDb,
  COLL,
  type AgentQueryJobDoc,
} from "@tiwi/mongodb";
import { runAgentQuery } from "./processors/runAgentQuery";

function logLine(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope: "agent_query_worker",
    message,
    ...meta,
  });
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

/** Per-job mutex so the same job is never run twice in this process. */
const inflight = new Set<string>();

async function processIfClaimed(jobId: string): Promise<void> {
  if (inflight.has(jobId)) return;
  inflight.add(jobId);
  try {
    const db = await getMongoDb();
    const claimed = await claimAgentQuery(db, jobId);
    if (!claimed) {
      logLine("INFO", "Job already claimed by another worker/loop", { jobId });
      return;
    }
    logLine("INFO", "Job claimed; invoking agent", {
      jobId,
      orgId: claimed.orgId,
      conversationId: claimed.conversationId,
    });
    await runAgentQuery(claimed);
  } catch (err) {
    logLine("ERROR", "Unhandled error in processIfClaimed", {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    inflight.delete(jobId);
  }
}

async function drainQueuedJobs(): Promise<void> {
  const db = await getMongoDb();
  const queued = await findQueuedAgentQueries(db);
  if (queued.length === 0) {
    logLine("INFO", "Startup drain: no queued jobs");
    return;
  }
  logLine("INFO", "Startup drain: processing queued jobs", {
    count: queued.length,
  });
  for (const job of queued) {
    // serial drain on startup is fine for the demo
    await processIfClaimed(job.jobId);
  }
}

async function watchChangeStream(): Promise<void> {
  const db = await getMongoDb();

  // `watch` with $match on operationType "insert" — fullDocument is the
  // freshly-inserted doc.
  const stream = db.collection(COLL.agentQueryJobs).watch(
    [{ $match: { operationType: "insert" } }],
    { fullDocument: "updateLookup" },
  );

  stream.on("change", (change) => {
    if (change.operationType !== "insert") return;
    const doc = change.fullDocument as AgentQueryJobDoc | undefined;
    if (!doc || !doc.jobId) return;
    // Fire and forget — change-stream callbacks should never block.
    void processIfClaimed(doc.jobId);
  });

  stream.on("error", (err) => {
    logLine("ERROR", "Agent query change stream error; reopening in 2s", {
      error: err instanceof Error ? err.message : String(err),
    });
    setTimeout(() => {
      void watchChangeStream().catch((retryErr) => {
        logLine("ERROR", "Failed to reopen change stream", {
          error:
            retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
      });
    }, 2_000);
  });

  logLine("INFO", "Agent query change stream open");
}

/**
 * Starts the agent-query worker:
 *  1. Drains any queued jobs that landed while the daemon was offline.
 *  2. Opens a Mongo change stream so new inserts trigger near-instant pickup.
 */
export async function startAgentQueryWorker(): Promise<void> {
  logLine("INFO", "Starting agent query worker");
  try {
    await drainQueuedJobs();
  } catch (err) {
    logLine("ERROR", "Startup drain failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await watchChangeStream();
  } catch (err) {
    logLine("ERROR", "Failed to open change stream", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
