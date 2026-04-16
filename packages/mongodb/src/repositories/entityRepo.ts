import type { Db } from "mongodb";
import { COLL } from "../collections";

function toIso(d: unknown): string {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string") return d;
  return "";
}

export type EntityType = {
  typeName: string;
  description: string;
  entityCount: number;
  isBuiltIn: boolean;
};

export type EntitySummary = {
  entityId: string;
  typeName: string;
  name: string;
  mentionCount: number;
};

export type EntityRecord = {
  orgId: string;
  entityId: string;
  typeName: string;
  name: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type RelationshipRecord = {
  relationshipId: string;
  fromEntityId: string;
  fromTypeName: string;
  fromName: string;
  toEntityId: string;
  toTypeName: string;
  toName: string;
  relationshipType: string;
  properties: Record<string, unknown>;
  createdAt: string;
};

export class EntityRepository {
  constructor(private readonly db: Db) {}

  async getAllEntityTypes(params: { orgId: string }): Promise<EntityType[]> {
    const types = await this.db
      .collection(COLL.typeRegistry)
      .find({ orgId: params.orgId })
      .sort({ typeName: 1 })
      .toArray();

    const out: EntityType[] = [];
    for (const t of types) {
      const typeName = String((t as unknown as { typeName: string }).typeName);
      const entityCount = await this.db.collection(COLL.entities).countDocuments({
        orgId: params.orgId,
        typeName,
      });
      out.push({
        typeName,
        description: String((t as { description?: string }).description ?? ""),
        entityCount,
        isBuiltIn: Boolean((t as { isBuiltIn?: boolean }).isBuiltIn),
      });
    }
    out.sort((a, b) => b.entityCount - a.entityCount || a.typeName.localeCompare(b.typeName));
    return out;
  }

  async getEntitiesSummary(params: { orgId: string; limit?: number }): Promise<EntitySummary[]> {
    const limit = params.limit ?? 100;
    const docs = await this.db
      .collection(COLL.entities)
      .find({ orgId: params.orgId })
      .toArray();

    const withCounts = docs.map((d) => {
      const x = d as unknown as {
        entityId: string;
        typeName: string;
        name: string;
        sourceFileIds?: string[];
      };
      return {
        entityId: x.entityId,
        typeName: x.typeName,
        name: x.name,
        mentionCount: Array.isArray(x.sourceFileIds) ? x.sourceFileIds.length : 0,
      };
    });
    withCounts.sort((a, b) => b.mentionCount - a.mentionCount || a.name.localeCompare(b.name));
    return withCounts.slice(0, limit);
  }

  async upsertEntity(params: {
    orgId: string;
    entityId: string;
    typeName: string;
    name: string;
    properties?: Record<string, unknown>;
    sourceFileId: string;
    confidence?: number;
  }): Promise<void> {
    const now = new Date();
    const nameLower = params.name.toLowerCase();
    const $set: Record<string, unknown> = {
      name: params.name,
      updatedAt: now,
    };
    if (params.properties !== undefined) {
      $set.properties = params.properties;
    }

    await this.db.collection(COLL.entities).updateOne(
      { orgId: params.orgId, typeName: params.typeName, nameLower },
      {
        $setOnInsert: {
          orgId: params.orgId,
          typeName: params.typeName,
          nameLower,
          entityId: params.entityId,
          properties: params.properties ?? {},
          sourceFileIds: [] as string[],
          createdAt: now,
        },
        $set,
        $addToSet: { sourceFileIds: params.sourceFileId },
      },
      { upsert: true },
    );
  }

  async upsertRelationship(params: {
    orgId: string;
    relationshipId: string;
    fromTypeName: string;
    fromName: string;
    toTypeName: string;
    toName: string;
    relationshipType: string;
    properties?: Record<string, unknown>;
    sourceFileId: string;
  }): Promise<void> {
    const from = await this.db.collection(COLL.entities).findOne({
      orgId: params.orgId,
      typeName: params.fromTypeName,
      nameLower: params.fromName.toLowerCase(),
    });
    const to = await this.db.collection(COLL.entities).findOne({
      orgId: params.orgId,
      typeName: params.toTypeName,
      nameLower: params.toName.toLowerCase(),
    });
    if (!from || !to) return;

    const fromE = from as unknown as { entityId: string; typeName: string; name: string };
    const toE = to as unknown as { entityId: string; typeName: string; name: string };

    await this.db.collection(COLL.entityRelationships).updateOne(
      {
        orgId: params.orgId,
        fromEntityId: fromE.entityId,
        toEntityId: toE.entityId,
        relationshipType: params.relationshipType,
        sourceFileId: params.sourceFileId,
      },
      {
        $setOnInsert: {
          orgId: params.orgId,
          relationshipId: params.relationshipId,
          fromEntityId: fromE.entityId,
          fromTypeName: fromE.typeName,
          fromName: fromE.name,
          toEntityId: toE.entityId,
          toTypeName: toE.typeName,
          toName: toE.name,
          relationshipType: params.relationshipType,
          sourceFileId: params.sourceFileId,
          createdAt: new Date(),
        },
        $set: {
          properties: params.properties ?? {},
        },
      },
      { upsert: true },
    );
  }

  async getEntitiesByFile(params: { orgId: string; fileId: string }): Promise<EntityRecord[]> {
    const docs = await this.db
      .collection(COLL.entities)
      .find({ orgId: params.orgId, sourceFileIds: params.fileId })
      .sort({ typeName: 1, name: 1 })
      .toArray();

    return docs.map((d) => {
      const x = d as Record<string, unknown>;
      return {
        orgId: String(x.orgId),
        entityId: String(x.entityId),
        typeName: String(x.typeName),
        name: String(x.name),
        properties: (x.properties as Record<string, unknown>) ?? {},
        createdAt: toIso(x.createdAt),
        updatedAt: toIso(x.updatedAt),
      };
    });
  }

  async getRelationshipsByFile(params: { orgId: string; fileId: string }): Promise<RelationshipRecord[]> {
    const docs = await this.db
      .collection(COLL.entityRelationships)
      .find({ orgId: params.orgId, sourceFileId: params.fileId })
      .sort({ relationshipType: 1, fromName: 1 })
      .toArray();

    return docs.map((d) => {
      const x = d as Record<string, unknown>;
      return {
        relationshipId: String(x.relationshipId),
        fromEntityId: String(x.fromEntityId),
        fromTypeName: String(x.fromTypeName),
        fromName: String(x.fromName),
        toEntityId: String(x.toEntityId),
        toTypeName: String(x.toTypeName),
        toName: String(x.toName),
        relationshipType: String(x.relationshipType),
        properties: (x.properties as Record<string, unknown>) ?? {},
        createdAt: toIso(x.createdAt),
      };
    });
  }

  async getEntityByName(params: {
    orgId: string;
    name: string;
    typeName?: string;
  }): Promise<EntityRecord | null> {
    const nameLower = params.name.toLowerCase();
    if (params.typeName) {
      const doc = await this.db.collection(COLL.entities).findOne({
        orgId: params.orgId,
        typeName: params.typeName,
        nameLower,
      });
      if (!doc) return null;
      const x = doc as Record<string, unknown>;
      return {
        orgId: String(x.orgId),
        entityId: String(x.entityId),
        typeName: String(x.typeName),
        name: String(x.name),
        properties: (x.properties as Record<string, unknown>) ?? {},
        createdAt: toIso(x.createdAt),
        updatedAt: toIso(x.updatedAt),
      };
    }

    const doc = await this.db.collection(COLL.entities).findOne({
      orgId: params.orgId,
      nameLower,
    });
    if (!doc) return null;
    const x = doc as Record<string, unknown>;
    return {
      orgId: String(x.orgId),
      entityId: String(x.entityId),
      typeName: String(x.typeName),
      name: String(x.name),
      properties: (x.properties as Record<string, unknown>) ?? {},
      createdAt: toIso(x.createdAt),
      updatedAt: toIso(x.updatedAt),
    };
  }

  async getRelatedEntities(params: {
    orgId: string;
    entityId: string;
    typeName: string;
    depth?: number;
  }): Promise<{ entities: EntityRecord[]; relationships: RelationshipRecord[] }> {
    const depth = params.depth ?? 2;
    const start = await this.db.collection(COLL.entities).findOne({
      orgId: params.orgId,
      entityId: params.entityId,
      typeName: params.typeName,
    });
    if (!start) return { entities: [], relationships: [] };

    let frontier: string[] = [params.entityId];
    const seenEntityIds = new Set<string>([params.entityId]);
    const relById = new Map<string, RelationshipRecord>();

    for (let d = 0; d < depth; d++) {
      if (frontier.length === 0) break;
      const rels = await this.db
        .collection(COLL.entityRelationships)
        .find({
          orgId: params.orgId,
          $or: [{ fromEntityId: { $in: frontier } }, { toEntityId: { $in: frontier } }],
        })
        .toArray();

      const next: string[] = [];
      for (const raw of rels) {
        const x = raw as Record<string, unknown>;
        const rid = String(x.relationshipId);
        if (relById.has(rid)) continue;

        relById.set(rid, {
          relationshipId: rid,
          fromEntityId: String(x.fromEntityId),
          fromTypeName: String(x.fromTypeName),
          fromName: String(x.fromName),
          toEntityId: String(x.toEntityId),
          toTypeName: String(x.toTypeName),
          toName: String(x.toName),
          relationshipType: String(x.relationshipType),
          properties: (x.properties as Record<string, unknown>) ?? {},
          createdAt: toIso(x.createdAt),
        });

        const fromId = String(x.fromEntityId);
        const toId = String(x.toEntityId);
        const other = frontier.includes(fromId) ? toId : fromId;
        if (!seenEntityIds.has(other)) {
          seenEntityIds.add(other);
          next.push(other);
        }
      }
      frontier = next;
    }

    const entityDocs = await this.db
      .collection(COLL.entities)
      .find({
        orgId: params.orgId,
        entityId: { $in: [...seenEntityIds].filter((id) => id !== params.entityId) },
      })
      .limit(50)
      .toArray();

    const entities: EntityRecord[] = entityDocs.map((d) => {
      const x = d as Record<string, unknown>;
      return {
        orgId: String(x.orgId),
        entityId: String(x.entityId),
        typeName: String(x.typeName),
        name: String(x.name),
        properties: (x.properties as Record<string, unknown>) ?? {},
        createdAt: toIso(x.createdAt),
        updatedAt: toIso(x.updatedAt),
      };
    });

    return { entities, relationships: [...relById.values()] };
  }

  async mergeEntities(params: {
    orgId: string;
    sourceEntityId: string;
    sourceTypeName: string;
    targetEntityId: string;
    targetTypeName: string;
  }): Promise<void> {
    const { orgId, sourceEntityId, targetEntityId } = params;

    await this.db.collection(COLL.entityRelationships).updateMany(
      { orgId, fromEntityId: sourceEntityId },
      { $set: { fromEntityId: targetEntityId } },
    );
    await this.db.collection(COLL.entityRelationships).updateMany(
      { orgId, toEntityId: sourceEntityId },
      { $set: { toEntityId: targetEntityId } },
    );

    const source = await this.db.collection(COLL.entities).findOne({ orgId, entityId: sourceEntityId });
    const target = await this.db.collection(COLL.entities).findOne({ orgId, entityId: targetEntityId });
    if (source && target) {
      const sIds = (source as { sourceFileIds?: string[] }).sourceFileIds ?? [];
      if (sIds.length > 0) {
        await this.db.collection(COLL.entities).updateOne(
          { orgId, entityId: targetEntityId },
          { $addToSet: { sourceFileIds: { $each: sIds } }, $set: { updatedAt: new Date() } },
        );
      }
    }

    await this.db.collection(COLL.entities).deleteOne({ orgId, entityId: sourceEntityId });

    await this.db.collection(COLL.entityRelationships).deleteMany({
      orgId,
      fromEntityId: targetEntityId,
      toEntityId: targetEntityId,
    });
  }

  async deleteEntitiesByType(params: { orgId: string; typeName: string }): Promise<void> {
    const cursor = this.db
      .collection(COLL.entities)
      .find({ orgId: params.orgId, typeName: params.typeName })
      .project({ entityId: 1 });
    const ids = (await cursor.toArray()).map((d) => String((d as { entityId: string }).entityId));
    if (ids.length === 0) return;

    await this.db.collection(COLL.entityRelationships).deleteMany({
      orgId: params.orgId,
      $or: [{ fromEntityId: { $in: ids } }, { toEntityId: { $in: ids } }],
    });
    await this.db.collection(COLL.entities).deleteMany({
      orgId: params.orgId,
      typeName: params.typeName,
    });
  }
}
