import {
  getMongoDb,
  closeMongoClient,
  FileRepository,
  LogRepository,
  claimNextFileJob,
  markFileJobProcessed,
  markFileJobFailed,
  type FileProcessingJobDoc,
} from "@tiwi/mongodb";
import { configureLangSmith } from "@tiwi/enrichment";
import { nanoid } from "nanoid";
import { ZodError } from "zod";
import { processFileV1 } from "./processors/processFileV1";
import type { ProcessFileV1Payload } from "./jobs/types";

const POLL_MS = 60_000;
const CONCURRENCY = 2;

function log(level: "INFO" | "WARN" | "ERROR", message: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta });
  if (level === "ERROR") console.error(line);
  else console.log(line);
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof ZodError) {
    const issues = err.issues.map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    });
    return `Validation error: ${issues.join("; ")}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function jobToPayload(job: FileProcessingJobDoc): ProcessFileV1Payload {
  return {
    orgId: job.orgId,
    userId: job.userId,
    fileId: job.fileId,
    objectKey: job.objectKey,
    contentType: job.contentType,
    originalName: job.originalName,
  };
}

async function processClaimedJob(params: {
  db: Awaited<ReturnType<typeof getMongoDb>>;
  job: FileProcessingJobDoc;
  fileRepo: FileRepository;
  logRepo: LogRepository;
}): Promise<void> {
  const { db, job, fileRepo, logRepo } = params;
  const payload = jobToPayload(job);
  const { orgId, fileId } = payload;

  log("INFO", "Job picked up", { jobId: String(job._id), orgId, fileId });
  await fileRepo.updateStatus({ orgId, fileId, status: "PROCESSING" });
  await logRepo.appendProcessingLog({
    orgId,
    fileId,
    logId: nanoid(),
    level: "INFO",
    message: "Started processing job",
    metadata: { jobId: String(job._id) },
  });

  try {
    await processFileV1(payload);

    log("INFO", "Job completed successfully", { jobId: String(job._id), orgId, fileId });
    await logRepo.appendProcessingLog({
      orgId,
      fileId,
      logId: nanoid(),
      level: "INFO",
      message: "Processing pipeline complete",
    });
    await fileRepo.updateStatus({ orgId, fileId, status: "PROCESSED" });
    await markFileJobProcessed(db, job._id);
  } catch (err) {
    const errorMessage = formatErrorMessage(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    log("ERROR", "Job failed", { jobId: String(job._id), orgId, fileId, error: errorMessage, stack: errorStack });
    const errorDetails = err instanceof ZodError ? { zodIssues: err.issues } : undefined;

    await logRepo.appendProcessingLog({
      orgId,
      fileId,
      logId: nanoid(),
      level: "ERROR",
      message: `Processing failed: ${errorMessage}`,
      metadata: { stack: errorStack, jobId: String(job._id), ...errorDetails },
    });
    await fileRepo.updateStatus({
      orgId,
      fileId,
      status: "FAILED",
      failureReason: errorMessage,
    });
    await markFileJobFailed(db, job._id, errorMessage);
  }
}

async function runPollCycle(): Promise<void> {
  log("INFO", "Polling MongoDB for queued file jobs");

  const db = await getMongoDb();
  const fileRepo = new FileRepository(db);
  const logRepo = new LogRepository(db);

  const pump = async () => {
    for (;;) {
      const job = await claimNextFileJob(db);
      if (!job) break;
      await processClaimedJob({ db, job, fileRepo, logRepo });
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => pump()));
}

export async function startWorker(): Promise<void> {
  configureLangSmith();
  log("INFO", "Starting file-processing worker (MongoDB poll)", { pollMs: POLL_MS, concurrency: CONCURRENCY });

  await runPollCycle().catch((err) => {
    log("ERROR", "Poll cycle failed", { error: formatErrorMessage(err) });
  });

  setInterval(() => {
    runPollCycle().catch((err) => {
      log("ERROR", "Poll cycle failed", { error: formatErrorMessage(err) });
    });
  }, POLL_MS);

  process.on("SIGINT", async () => {
    await closeMongoClient();
    process.exit(0);
  });
}
