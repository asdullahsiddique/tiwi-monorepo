import type { Db, ModifyResult, ObjectId } from "mongodb";
import { COLL } from "./collections";

export type FileProcessingJobPayload = {
  orgId: string;
  userId: string;
  fileId: string;
  objectKey: string;
  contentType: string;
  originalName: string;
};

export type FileProcessingJobDoc = FileProcessingJobPayload & {
  _id: ObjectId;
  status: "queued" | "processing" | "processed" | "failed";
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
};

export async function enqueueFileProcessing(db: Db, payload: FileProcessingJobPayload): Promise<void> {
  const now = new Date();
  await db.collection(COLL.fileProcessingJobs).insertOne({
    ...payload,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  });
}

export async function claimNextFileJob(db: Db): Promise<FileProcessingJobDoc | null> {
  const res = (await db.collection(COLL.fileProcessingJobs).findOneAndUpdate(
    { status: "queued" },
    { $set: { status: "processing", updatedAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  )) as unknown as ModifyResult<FileProcessingJobDoc> | FileProcessingJobDoc | null;

  if (res && typeof res === "object" && "value" in res) {
    return (res as ModifyResult<FileProcessingJobDoc>).value ?? null;
  }
  if (res && typeof res === "object" && "orgId" in res && "fileId" in res) {
    return res as FileProcessingJobDoc;
  }
  return null;
}

export async function markFileJobProcessed(db: Db, jobId: ObjectId): Promise<void> {
  await db.collection(COLL.fileProcessingJobs).updateOne(
    { _id: jobId },
    { $set: { status: "processed", updatedAt: new Date() } },
  );
}

export async function markFileJobFailed(
  db: Db,
  jobId: ObjectId,
  failureReason: string,
): Promise<void> {
  await db.collection(COLL.fileProcessingJobs).updateOne(
    { _id: jobId },
    { $set: { status: "failed", failureReason, updatedAt: new Date() } },
  );
}
