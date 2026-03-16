import { Worker } from "bullmq";
import { createNeo4jDriver, ensureNeo4jSchema, FileRepository, LogRepository } from "@tiwi/neo4j";
import { configureLangSmith } from "@tiwi/enrichment";
import { nanoid } from "nanoid";
import { ZodError } from "zod";
import { getDaemonEnv } from "./env";
import { JOB_PROCESS_FILE_V1, ProcessFileV1Payload, QUEUE_NAME } from "./jobs/types";
import { processFileV1 } from "./processors/processFileV1";

function formatErrorMessage(err: unknown): string {
  if (err instanceof ZodError) {
    // Format Zod validation errors in a readable way
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

export async function startWorker(): Promise<void> {
  const { REDIS_URL } = getDaemonEnv();

  // Configure LangSmith tracing if enabled
  configureLangSmith();

  const driver = createNeo4jDriver();
  await ensureNeo4jSchema(driver);

  const fileRepo = new FileRepository(driver);
  const logRepo = new LogRepository(driver);

  const worker = new Worker<ProcessFileV1Payload>(
    QUEUE_NAME,
    async (job) => {
      if (job.name !== JOB_PROCESS_FILE_V1) return;

      const { orgId, fileId } = job.data;
      await fileRepo.updateStatus({ orgId, fileId, status: "PROCESSING" });
      await logRepo.appendProcessingLog({
        orgId,
        fileId,
        logId: nanoid(),
        level: "INFO",
        message: "Started processing job",
        metadata: { jobId: job.id, name: job.name },
      });

      try {
        await processFileV1(job.data);

        await logRepo.appendProcessingLog({
          orgId,
          fileId,
          logId: nanoid(),
          level: "INFO",
          message: "Processing pipeline complete",
        });
        await fileRepo.updateStatus({ orgId, fileId, status: "PROCESSED" });
      } catch (err) {
        const errorMessage = formatErrorMessage(err);
        const errorStack = err instanceof Error ? err.stack : undefined;
        const errorDetails = err instanceof ZodError 
          ? { zodIssues: err.issues } 
          : undefined;
        
        await logRepo.appendProcessingLog({
          orgId,
          fileId,
          logId: nanoid(),
          level: "ERROR",
          message: `Processing failed: ${errorMessage}`,
          metadata: { stack: errorStack, jobId: job.id, ...errorDetails },
        });
        await fileRepo.updateStatus({ 
          orgId, 
          fileId, 
          status: "FAILED", 
          failureReason: errorMessage 
        });
        
        // Re-throw so BullMQ also records the failure
        throw err;
      }
    },
    {
      connection: { url: REDIS_URL },
      concurrency: 2,
      // Reduce Redis command volume on Upstash free tier.
      // stalledInterval: how often to check for stalled jobs (default: 30s → 5min)
      stalledInterval: 300_000,
      // lockDuration: how long a job lock is held before renewal (default: 30s → 2min)
      // lock is renewed every lockDuration/2, so this halves renewal frequency
      lockDuration: 120_000,
    },
  );

  worker.on("failed", async (job, err) => {
    const orgId = (job?.data as any)?.orgId;
    const fileId = (job?.data as any)?.fileId;
    if (orgId && fileId) {
      const errorMessage = formatErrorMessage(err);
      const errorDetails = err instanceof ZodError 
        ? { zodIssues: err.issues } 
        : undefined;
      
      await fileRepo.updateStatus({ orgId, fileId, status: "FAILED", failureReason: errorMessage });
      await logRepo.appendProcessingLog({
        orgId,
        fileId,
        logId: nanoid(),
        level: "ERROR",
        message: `Job failed: ${errorMessage}`,
        metadata: { stack: err.stack, jobId: job?.id, ...errorDetails },
      });
    }
  });

  process.on("SIGINT", async () => {
    await worker.close();
    await driver.close();
    process.exit(0);
  });
}

