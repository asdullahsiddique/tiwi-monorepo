import type { Db } from "mongodb";
import { COLL } from "../collections";

export type CustomPromptPlacement = "prepend" | "append" | "post_process";

export type CustomPromptRecord = {
  promptId: string;
  orgId: string;
  name: string;
  description: string | null;
  body: string;
  placement: CustomPromptPlacement;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

function toIso(d: unknown): string {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string") return d;
  return "";
}

function mapDoc(d: Record<string, unknown>): CustomPromptRecord {
  return {
    promptId: String(d.promptId),
    orgId: String(d.orgId),
    name: String(d.name),
    description: d.description != null ? String(d.description) : null,
    body: String(d.body),
    placement: (d.placement as CustomPromptPlacement) ?? "prepend",
    createdByUserId: String(d.createdByUserId ?? ""),
    createdAt: toIso(d.createdAt),
    updatedAt: toIso(d.updatedAt),
  };
}

export class CustomPromptRepository {
  constructor(private readonly db: Db) {}

  async ensureIndexes(): Promise<void> {
    const coll = this.db.collection(COLL.customPrompts);
    await coll.createIndex({ orgId: 1, promptId: 1 }, { unique: true });
    await coll.createIndex({ orgId: 1, updatedAt: -1 });
  }

  async create(params: {
    orgId: string;
    promptId: string;
    name: string;
    description?: string | null;
    body: string;
    placement: CustomPromptPlacement;
    createdByUserId: string;
  }): Promise<CustomPromptRecord> {
    const now = new Date();
    const doc = {
      promptId: params.promptId,
      orgId: params.orgId,
      name: params.name,
      description: params.description ?? null,
      body: params.body,
      placement: params.placement,
      createdByUserId: params.createdByUserId,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.collection(COLL.customPrompts).insertOne(doc);
    return mapDoc(doc);
  }

  async list(params: { orgId: string }): Promise<CustomPromptRecord[]> {
    const docs = await this.db
      .collection(COLL.customPrompts)
      .find({ orgId: params.orgId })
      .sort({ updatedAt: -1 })
      .toArray();
    return docs.map((d) => mapDoc(d as Record<string, unknown>));
  }

  async getByIds(params: {
    orgId: string;
    promptIds: string[];
  }): Promise<CustomPromptRecord[]> {
    if (params.promptIds.length === 0) return [];
    const docs = await this.db
      .collection(COLL.customPrompts)
      .find({ orgId: params.orgId, promptId: { $in: params.promptIds } })
      .toArray();
    return docs.map((d) => mapDoc(d as Record<string, unknown>));
  }

  async update(params: {
    orgId: string;
    promptId: string;
    name?: string;
    description?: string | null;
    body?: string;
    placement?: CustomPromptPlacement;
  }): Promise<CustomPromptRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (params.name !== undefined) set.name = params.name;
    if (params.description !== undefined) set.description = params.description;
    if (params.body !== undefined) set.body = params.body;
    if (params.placement !== undefined) set.placement = params.placement;

    const res = await this.db.collection(COLL.customPrompts).findOneAndUpdate(
      { orgId: params.orgId, promptId: params.promptId },
      { $set: set },
      { returnDocument: "after" },
    );
    if (!res) return null;
    return mapDoc(res as Record<string, unknown>);
  }

  async delete(params: { orgId: string; promptId: string }): Promise<boolean> {
    const res = await this.db
      .collection(COLL.customPrompts)
      .deleteOne({ orgId: params.orgId, promptId: params.promptId });
    return res.deletedCount > 0;
  }
}
