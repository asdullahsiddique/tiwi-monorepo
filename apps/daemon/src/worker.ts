import { Worker } from "bullmq";
import { createNeo4jDriver, ensureNeo4jSchema, FileRepository, LogRepository } from "@tiwi/neo4j";
import { nanoid } from "nanoid";
import { getDaemonEnv } from "./env";
import { JOB_PROCESS_FILE_V1, ProcessFileV1Payload, QUEUE_NAME } from "./jobs/types";
import { processFileV1 } from "./processors/processFileV1";

export async function startWorker(): Promise<void> {
  const { REDIS_URL } = getDaemonEnv();

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

      await processFileV1(job.data);

      await logRepo.appendProcessingLog({
        orgId,
        fileId,
        logId: nanoid(),
        level: "INFO",
        message: "Processing pipeline complete",
      });
      await fileRepo.updateStatus({ orgId, fileId, status: "PROCESSED" });
    },
    {
      connection: { url: REDIS_URL },
      concurrency: 4,
    },
  );

  worker.on("failed", async (job, err) => {
    const orgId = (job?.data as any)?.orgId;
    const fileId = (job?.data as any)?.fileId;
    if (orgId && fileId) {
      await fileRepo.updateStatus({ orgId, fileId, status: "FAILED", failureReason: err.message });
      await logRepo.appendProcessingLog({
        orgId,
        fileId,
        logId: nanoid(),
        level: "ERROR",
        message: "Job failed",
        metadata: { error: err.message, stack: err.stack, jobId: job?.id },
      });
    }
  });

  process.on("SIGINT", async () => {
    await worker.close();
    await driver.close();
    process.exit(0);
  });
}

