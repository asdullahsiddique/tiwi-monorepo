import type { Db } from "mongodb";
import { COLL } from "../collections";
import { OrgRepository } from "./orgRepo";

export type FileStatus =
  | "UPLOADING"
  | "UPLOADED"
  | "QUEUED"
  | "PROCESSING"
  | "PROCESSED"
  | "FAILED";

export type FileRecord = {
  orgId: string;
  userId: string;
  fileId: string;
  objectKey: string;
  originalName: string;
  contentType: string;
  sizeBytes?: number;
  status: FileStatus;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
};

function toIso(d: unknown): string {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string") return d;
  return new Date().toISOString();
}

function docToFile(doc: Record<string, unknown>): FileRecord {
  return {
    orgId: String(doc.orgId),
    userId: String(doc.userId),
    fileId: String(doc.fileId),
    objectKey: String(doc.objectKey),
    originalName: String(doc.originalName),
    contentType: String(doc.contentType),
    sizeBytes: doc.sizeBytes !== undefined && doc.sizeBytes !== null ? Number(doc.sizeBytes) : undefined,
    status: doc.status as FileStatus,
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
    failureReason: doc.failureReason ? String(doc.failureReason) : undefined,
  };
}

export class FileRepository {
  constructor(private readonly db: Db) {}

  async upsertFile(params: {
    orgId: string;
    userId: string;
    fileId: string;
    objectKey: string;
    originalName: string;
    contentType: string;
    sizeBytes?: number;
    status: FileStatus;
  }): Promise<void> {
    const orgRepo = new OrgRepository(this.db);
    await orgRepo.ensureOrgAndUser({ orgId: params.orgId, userId: params.userId });

    const now = new Date();
    await this.db.collection(COLL.files).updateOne(
      { orgId: params.orgId, fileId: params.fileId },
      {
        $set: {
          orgId: params.orgId,
          userId: params.userId,
          fileId: params.fileId,
          objectKey: params.objectKey,
          originalName: params.originalName,
          contentType: params.contentType,
          sizeBytes: params.sizeBytes ?? null,
          status: params.status,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }

  async updateStatus(params: {
    orgId: string;
    fileId: string;
    status: FileStatus;
    failureReason?: string;
  }): Promise<void> {
    const now = new Date();
    const $set: Record<string, unknown> = {
      status: params.status,
      updatedAt: now,
    };
    if (params.failureReason !== undefined) {
      $set.failureReason = params.failureReason;
    }
    await this.db.collection(COLL.files).updateOne(
      { orgId: params.orgId, fileId: params.fileId },
      { $set },
    );
  }

  async getFile(params: { orgId: string; fileId: string }): Promise<FileRecord | null> {
    const doc = await this.db.collection(COLL.files).findOne({
      orgId: params.orgId,
      fileId: params.fileId,
    });
    if (!doc) return null;
    return docToFile(doc as Record<string, unknown>);
  }

  async listFiles(params: { orgId: string; limit: number; offset: number }): Promise<FileRecord[]> {
    const cursor = this.db
      .collection(COLL.files)
      .find({ orgId: params.orgId })
      .sort({ createdAt: -1 })
      .skip(params.offset)
      .limit(params.limit);
    const docs = await cursor.toArray();
    return docs.map((d) => docToFile(d as Record<string, unknown>));
  }

  async getFilesByIds(params: { orgId: string; fileIds: string[] }): Promise<FileRecord[]> {
    if (params.fileIds.length === 0) return [];
    const docs = await this.db
      .collection(COLL.files)
      .find({ orgId: params.orgId, fileId: { $in: params.fileIds } })
      .toArray();
    return docs.map((d) => docToFile(d as Record<string, unknown>));
  }
}
