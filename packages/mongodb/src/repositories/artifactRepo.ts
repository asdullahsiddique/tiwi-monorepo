import type { Db } from "mongodb";
import { COLL } from "../collections";

export class ArtifactRepository {
  constructor(private readonly db: Db) {}

  async setFileExtractedText(params: { orgId: string; fileId: string; text: string }): Promise<void> {
    const now = new Date();
    await this.db.collection(COLL.files).updateOne(
      { orgId: params.orgId, fileId: params.fileId },
      { $set: { extractedText: params.text, extractedTextUpdatedAt: now, updatedAt: now } },
    );
  }

  async getFileExtractedText(params: { orgId: string; fileId: string }): Promise<string | null> {
    const doc = await this.db.collection(COLL.files).findOne(
      { orgId: params.orgId, fileId: params.fileId },
      { projection: { extractedText: 1 } },
    );
    if (!doc || doc.extractedText == null) return null;
    return String(doc.extractedText);
  }

  async setFileSummary(params: { orgId: string; fileId: string; summary: string }): Promise<void> {
    const now = new Date();
    await this.db.collection(COLL.files).updateOne(
      { orgId: params.orgId, fileId: params.fileId },
      { $set: { summary: params.summary, summaryUpdatedAt: now, updatedAt: now } },
    );
  }

  async getFileSummary(params: { orgId: string; fileId: string }): Promise<string | null> {
    const doc = await this.db.collection(COLL.files).findOne(
      { orgId: params.orgId, fileId: params.fileId },
      { projection: { summary: 1 } },
    );
    if (!doc || doc.summary == null) return null;
    return String(doc.summary);
  }
}
