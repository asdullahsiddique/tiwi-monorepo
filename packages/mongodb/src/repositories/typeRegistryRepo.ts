import type { Db } from "mongodb";
import { COLL } from "../collections";

export type TypeRegistryRecord = {
  orgId: string;
  typeName: string;
  description: string;
  properties: string[];
  status: "active" | "draft";
  createdBy: "user" | "ai";
  isBuiltIn?: boolean;
  createdAt: string;
  updatedAt: string;
};

function toIso(d: unknown): string {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string") return d;
  return "";
}

function docToRecord(doc: Record<string, unknown>): TypeRegistryRecord {
  return {
    orgId: String(doc.orgId),
    typeName: String(doc.typeName),
    description: String(doc.description ?? ""),
    properties: Array.isArray(doc.properties) ? (doc.properties as string[]) : [],
    status: (doc.status as TypeRegistryRecord["status"]) ?? "active",
    createdBy: (doc.createdBy as TypeRegistryRecord["createdBy"]) ?? "user",
    isBuiltIn: doc.isBuiltIn !== undefined ? Boolean(doc.isBuiltIn) : undefined,
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt ?? doc.createdAt),
  };
}

export class TypeRegistryRepository {
  constructor(private readonly db: Db) {}

  async getType(params: { orgId: string; typeName: string }): Promise<TypeRegistryRecord | null> {
    const doc = await this.db.collection(COLL.typeRegistry).findOne({
      orgId: params.orgId,
      typeName: params.typeName,
    });
    if (!doc) return null;
    return docToRecord(doc as Record<string, unknown>);
  }

  async createType(params: {
    orgId: string;
    typeName: string;
    description: string;
    properties?: string[];
    status?: "active" | "draft";
    createdBy?: "user" | "ai";
    isBuiltIn?: boolean;
  }): Promise<void> {
    const now = new Date();
    await this.db.collection(COLL.typeRegistry).updateOne(
      { orgId: params.orgId, typeName: params.typeName },
      {
        $setOnInsert: {
          orgId: params.orgId,
          typeName: params.typeName,
          createdAt: now,
          isBuiltIn: params.isBuiltIn ?? false,
        },
        $set: {
          description: params.description,
          properties: params.properties ?? [],
          status: params.status ?? "active",
          createdBy: params.createdBy ?? "user",
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  }

  async listTypes(params: { orgId: string }): Promise<TypeRegistryRecord[]> {
    const docs = await this.db
      .collection(COLL.typeRegistry)
      .find({ orgId: params.orgId })
      .sort({ status: 1, typeName: 1 })
      .toArray();
    return docs.map((d) => docToRecord(d as Record<string, unknown>));
  }

  async updateType(params: {
    orgId: string;
    typeName: string;
    description?: string;
    properties?: string[];
  }): Promise<void> {
    const $set: Record<string, unknown> = { updatedAt: new Date() };
    if (params.description !== undefined) $set.description = params.description;
    if (params.properties !== undefined) $set.properties = params.properties;
    await this.db.collection(COLL.typeRegistry).updateOne(
      { orgId: params.orgId, typeName: params.typeName },
      { $set },
    );
  }

  async deleteType(params: { orgId: string; typeName: string }): Promise<void> {
    await this.db.collection(COLL.typeRegistry).deleteOne({
      orgId: params.orgId,
      typeName: params.typeName,
    });
  }

  async confirmDraftType(params: { orgId: string; typeName: string }): Promise<void> {
    await this.db.collection(COLL.typeRegistry).updateOne(
      { orgId: params.orgId, typeName: params.typeName },
      { $set: { status: "active", updatedAt: new Date() } },
    );
  }

  async dismissDraftType(params: { orgId: string; typeName: string }): Promise<void> {
    await this.db.collection(COLL.typeRegistry).deleteOne({
      orgId: params.orgId,
      typeName: params.typeName,
    });
  }
}
