import { nanoid } from "nanoid";
import { newFileId } from "@tiwi/shared";
import { buildObjectKey, createPresignedPutUrl } from "@tiwi/storage";
import {
  getNeo4jDriver,
  ensureNeo4jSchema,
  FileRepository,
  LogRepository,
} from "@tiwi/neo4j";
import { createQueue } from "../queue";

export type RequestUploadInput = {
  orgId: string;
  userId: string;
  originalName: string;
  contentType: string;
  folder?: string;
};

export type RequestUploadResult = {
  fileId: string;
  objectKey: string;
  uploadUrl: string;
};

function getExtFromFilename(name: string): string | undefined {
  const idx = name.lastIndexOf(".");
  if (idx < 0) return undefined;
  const ext = name
    .slice(idx + 1)
    .trim()
    .toLowerCase();
  if (!ext) return undefined;
  if (ext.length > 12) return undefined;
  return ext.replace(/[^a-z0-9]/g, "");
}

export async function requestUpload(
  input: RequestUploadInput,
): Promise<RequestUploadResult> {
  const fileId = newFileId();
  const ext = getExtFromFilename(input.originalName);
  const objectKey = buildObjectKey({
    orgId: input.orgId,
    userId: input.userId,
    folder: input.folder,
    fileId,
    ext,
  });

  const driver = getNeo4jDriver();
  await ensureNeo4jSchema(driver);
  const fileRepo = new FileRepository(driver);
  const logRepo = new LogRepository(driver);

  await fileRepo.upsertFile({
    orgId: input.orgId,
    userId: input.userId,
    fileId,
    objectKey,
    originalName: input.originalName,
    contentType: input.contentType,
    status: "UPLOADING",
  });

  await logRepo.appendProcessingLog({
    orgId: input.orgId,
    fileId,
    logId: nanoid(),
    level: "INFO",
    message: "Upload initialized; presigned URL issued",
    metadata: { objectKey, contentType: input.contentType },
  });

  const uploadUrl = await createPresignedPutUrl({
    objectKey,
    contentType: input.contentType,
  });

  return { fileId, objectKey, uploadUrl };
}

export async function commitUpload(input: {
  orgId: string;
  userId: string;
  fileId: string;
  objectKey: string;
  originalName: string;
  contentType: string;
  sizeBytes?: number;
}): Promise<{ ok: true }> {
  const driver = getNeo4jDriver();
  const queue = createQueue("tiwi-file-processing");

  try {
    await ensureNeo4jSchema(driver);
    const fileRepo = new FileRepository(driver);
    const logRepo = new LogRepository(driver);

    await fileRepo.upsertFile({
      orgId: input.orgId,
      userId: input.userId,
      fileId: input.fileId,
      objectKey: input.objectKey,
      originalName: input.originalName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      status: "UPLOADED",
    });

    await fileRepo.updateStatus({
      orgId: input.orgId,
      fileId: input.fileId,
      status: "QUEUED",
    });

    await logRepo.appendProcessingLog({
      orgId: input.orgId,
      fileId: input.fileId,
      logId: nanoid(),
      level: "INFO",
      message: "Upload committed; enqueued processing job",
      metadata: { objectKey: input.objectKey, contentType: input.contentType },
    });

    await queue.add(
      "ProcessFileV1",
      {
        orgId: input.orgId,
        userId: input.userId,
        fileId: input.fileId,
        objectKey: input.objectKey,
        contentType: input.contentType,
        originalName: input.originalName,
      },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );

    return { ok: true };
  } finally {
    await queue.close();
    // Note: don't close driver — it's a singleton
  }
}

/**
 * Reprocess a file by resetting its status and re-queueing it.
 * This can be used to retry failed files or regenerate processed files.
 */
export async function reprocessFile(input: {
  orgId: string;
  userId: string;
  fileId: string;
}): Promise<{ ok: true }> {
  const driver = getNeo4jDriver();
  const queue = createQueue("tiwi-file-processing");

  try {
    await ensureNeo4jSchema(driver);
    const fileRepo = new FileRepository(driver);
    const logRepo = new LogRepository(driver);

    // Get the existing file
    const file = await fileRepo.getFile({ orgId: input.orgId, fileId: input.fileId });
    if (!file) {
      throw new Error("File not found");
    }

    // Reset status to QUEUED
    await fileRepo.updateStatus({
      orgId: input.orgId,
      fileId: input.fileId,
      status: "QUEUED",
    });

    await logRepo.appendProcessingLog({
      orgId: input.orgId,
      fileId: input.fileId,
      logId: nanoid(),
      level: "INFO",
      message: "Reprocessing requested; re-enqueued processing job",
      metadata: { previousStatus: file.status, requestedBy: input.userId },
    });

    await queue.add(
      "ProcessFileV1",
      {
        orgId: input.orgId,
        userId: input.userId,
        fileId: input.fileId,
        objectKey: file.objectKey,
        contentType: file.contentType,
        originalName: file.originalName,
      },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );

    return { ok: true };
  } finally {
    await queue.close();
  }
}
