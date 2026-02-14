import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";

/**
 * Safely convert a Neo4j value to a number.
 * Handles Integer objects, plain numbers, and null/undefined.
 */
function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (neo4j.isInt(value)) return value.toNumber();
  return Number(value) || 0;
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
  fromName: string;
  toEntityId: string;
  toName: string;
  relationshipType: string;
  properties: Record<string, unknown>;
  createdAt: string;
};

export class EntityRepository {
  constructor(private readonly driver: Driver) {}

  /**
   * Get all entity types for an organization (for AI context).
   * Returns both built-in and custom types with counts.
   */
  async getAllEntityTypes(params: { orgId: string }): Promise<EntityType[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      // Get built-in types from TypeRegistry
      const typesResult = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (t:TypeRegistry {orgId: $orgId})
OPTIONAL MATCH (e:Entity {orgId: $orgId, typeName: t.typeName})
RETURN t.typeName AS typeName, t.description AS description, t.isBuiltIn AS isBuiltIn, count(e) AS entityCount
ORDER BY entityCount DESC, typeName
          `,
          { orgId: params.orgId }
        )
      );

      // Also get types from entities that may not be in registry
      const entityTypesResult = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (e:Entity {orgId: $orgId})
WHERE NOT EXISTS { MATCH (t:TypeRegistry {orgId: $orgId, typeName: e.typeName}) }
RETURN e.typeName AS typeName, count(e) AS entityCount
ORDER BY entityCount DESC
          `,
          { orgId: params.orgId }
        )
      );

      const types: EntityType[] = typesResult.records.map((r) => ({
        typeName: r.get("typeName"),
        description: r.get("description") ?? "",
        entityCount: toNumber(r.get("entityCount")),
        isBuiltIn: r.get("isBuiltIn") ?? false,
      }));

      // Add unregistered types
      for (const r of entityTypesResult.records) {
        types.push({
          typeName: r.get("typeName"),
          description: "",
          entityCount: toNumber(r.get("entityCount")),
          isBuiltIn: false,
        });
      }

      return types;
    } finally {
      await session.close();
    }
  }

  /**
   * Get summary of existing entities for AI context.
   * Returns most-mentioned entities to help AI resolve matches.
   */
  async getEntitiesSummary(params: {
    orgId: string;
    limit?: number;
  }): Promise<EntitySummary[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    const limit = params.limit ?? 100;
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (e:Entity {orgId: $orgId})
OPTIONAL MATCH (e)-[:EXTRACTED_FROM]->(f:File)
RETURN e.entityId AS entityId, e.typeName AS typeName, e.name AS name, count(f) AS mentionCount
ORDER BY mentionCount DESC, e.name
LIMIT $limit
          `,
          { orgId: params.orgId, limit: neo4j.int(limit) }
        )
      );

      return result.records.map((r) => ({
        entityId: r.get("entityId"),
        typeName: r.get("typeName"),
        name: r.get("name"),
        mentionCount: toNumber(r.get("mentionCount")),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Upsert an entity. If entity with same name+type exists, update it.
   * Links entity to source file.
   */
  async upsertEntity(params: {
    orgId: string;
    entityId: string;
    typeName: string;
    name: string;
    properties?: Record<string, unknown>;
    sourceFileId: string;
    confidence?: number;
  }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite(async (tx) => {
        // Upsert entity - match by orgId + typeName + name (case-insensitive)
        await tx.run(
          `
MERGE (e:Entity {orgId: $orgId, typeName: $typeName, nameLower: toLower($name)})
  ON CREATE SET
    e.entityId = $entityId,
    e.name = $name,
    e.properties = $properties,
    e.createdAt = datetime(),
    e.updatedAt = datetime()
  ON MATCH SET
    e.properties = CASE WHEN $properties IS NOT NULL THEN $properties ELSE e.properties END,
    e.updatedAt = datetime()
          `,
          {
            orgId: params.orgId,
            entityId: params.entityId,
            typeName: params.typeName,
            name: params.name,
            properties: params.properties ? JSON.stringify(params.properties) : null,
          }
        );

        // Link entity to organization
        await tx.run(
          `
MATCH (e:Entity {orgId: $orgId, typeName: $typeName, nameLower: toLower($name)})
MATCH (o:Organization {orgId: $orgId})
MERGE (o)-[:HAS_ENTITY]->(e)
          `,
          { orgId: params.orgId, typeName: params.typeName, name: params.name }
        );

        // Link entity to source file
        await tx.run(
          `
MATCH (e:Entity {orgId: $orgId, typeName: $typeName, nameLower: toLower($name)})
MATCH (f:File {orgId: $orgId, fileId: $fileId})
MERGE (e)-[r:EXTRACTED_FROM]->(f)
  ON CREATE SET r.confidence = $confidence, r.createdAt = datetime()
          `,
          {
            orgId: params.orgId,
            typeName: params.typeName,
            name: params.name,
            fileId: params.sourceFileId,
            confidence: params.confidence ?? 1.0,
          }
        );
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Create a relationship between two entities.
   * Entities are matched by name (case-insensitive).
   */
  async upsertRelationship(params: {
    orgId: string;
    relationshipId: string;
    fromName: string;
    toName: string;
    relationshipType: string;
    properties?: Record<string, unknown>;
    sourceFileId: string;
  }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      // Use APOC or dynamic relationship type via Cypher
      // Since relationship types are dynamic, we use a workaround with CALL subquery
      await session.executeWrite(async (tx) => {
        // First, ensure both entities exist (they should from prior upserts)
        // Then create the relationship with the dynamic type
        // Neo4j requires relationship types to be known at query time,
        // so we'll store the type as a property and use a generic relationship
        await tx.run(
          `
MATCH (from:Entity {orgId: $orgId, nameLower: toLower($fromName)})
MATCH (to:Entity {orgId: $orgId, nameLower: toLower($toName)})
MERGE (from)-[r:RELATES_TO {relationshipType: $relationshipType}]->(to)
  ON CREATE SET
    r.relationshipId = $relationshipId,
    r.properties = $properties,
    r.sourceFileId = $sourceFileId,
    r.createdAt = datetime()
  ON MATCH SET
    r.properties = CASE WHEN $properties IS NOT NULL THEN $properties ELSE r.properties END
          `,
          {
            orgId: params.orgId,
            relationshipId: params.relationshipId,
            fromName: params.fromName,
            toName: params.toName,
            relationshipType: params.relationshipType,
            properties: params.properties ? JSON.stringify(params.properties) : null,
            sourceFileId: params.sourceFileId,
          }
        );
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Get all entities extracted from a specific file.
   */
  async getEntitiesByFile(params: {
    orgId: string;
    fileId: string;
  }): Promise<EntityRecord[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (e:Entity {orgId: $orgId})-[:EXTRACTED_FROM]->(f:File {orgId: $orgId, fileId: $fileId})
RETURN e
ORDER BY e.typeName, e.name
          `,
          { orgId: params.orgId, fileId: params.fileId }
        )
      );

      return result.records.map((r) => {
        const e = r.get("e").properties;
        return {
          orgId: e.orgId,
          entityId: e.entityId,
          typeName: e.typeName,
          name: e.name,
          properties: e.properties ? JSON.parse(e.properties) : {},
          createdAt: e.createdAt?.toString() ?? "",
          updatedAt: e.updatedAt?.toString() ?? "",
        };
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Get all relationships extracted from a specific file.
   */
  async getRelationshipsByFile(params: {
    orgId: string;
    fileId: string;
  }): Promise<RelationshipRecord[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (from:Entity {orgId: $orgId})-[r:RELATES_TO {sourceFileId: $fileId}]->(to:Entity {orgId: $orgId})
RETURN r, from.entityId AS fromEntityId, from.name AS fromName, to.entityId AS toEntityId, to.name AS toName
ORDER BY r.relationshipType, from.name
          `,
          { orgId: params.orgId, fileId: params.fileId }
        )
      );

      return result.records.map((r) => {
        const rel = r.get("r").properties;
        return {
          relationshipId: rel.relationshipId,
          fromEntityId: r.get("fromEntityId"),
          fromName: r.get("fromName"),
          toEntityId: r.get("toEntityId"),
          toName: r.get("toName"),
          relationshipType: rel.relationshipType,
          properties: rel.properties ? JSON.parse(rel.properties) : {},
          createdAt: rel.createdAt?.toString() ?? "",
        };
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Get entity by name (case-insensitive match).
   */
  async getEntityByName(params: {
    orgId: string;
    name: string;
    typeName?: string;
  }): Promise<EntityRecord | null> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const query = params.typeName
        ? `
MATCH (e:Entity {orgId: $orgId, typeName: $typeName, nameLower: toLower($name)})
RETURN e
          `
        : `
MATCH (e:Entity {orgId: $orgId, nameLower: toLower($name)})
RETURN e
LIMIT 1
          `;

      const result = await session.executeRead((tx) =>
        tx.run(query, {
          orgId: params.orgId,
          name: params.name,
          typeName: params.typeName ?? null,
        })
      );

      if (result.records.length === 0) return null;

      const e = result.records[0].get("e").properties;
      return {
        orgId: e.orgId,
        entityId: e.entityId,
        typeName: e.typeName,
        name: e.name,
        properties: e.properties ? JSON.parse(e.properties) : {},
        createdAt: e.createdAt?.toString() ?? "",
        updatedAt: e.updatedAt?.toString() ?? "",
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Get related entities via graph traversal.
   */
  async getRelatedEntities(params: {
    orgId: string;
    entityId: string;
    depth?: number;
  }): Promise<{ entities: EntityRecord[]; relationships: RelationshipRecord[] }> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    const depth = params.depth ?? 2;
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (start:Entity {orgId: $orgId, entityId: $entityId})
CALL {
  WITH start
  MATCH path = (start)-[:RELATES_TO*1..${depth}]-(related:Entity {orgId: $orgId})
  RETURN related, relationships(path) AS rels
}
RETURN collect(DISTINCT related) AS entities, collect(DISTINCT rels) AS allRels
          `,
          { orgId: params.orgId, entityId: params.entityId }
        )
      );

      const entities: EntityRecord[] = [];
      const relationships: RelationshipRecord[] = [];

      if (result.records.length > 0) {
        const record = result.records[0];
        const entityNodes = record.get("entities") ?? [];
        
        for (const node of entityNodes) {
          if (node && node.properties) {
            const e = node.properties;
            entities.push({
              orgId: e.orgId,
              entityId: e.entityId,
              typeName: e.typeName,
              name: e.name,
              properties: e.properties ? JSON.parse(e.properties) : {},
              createdAt: e.createdAt?.toString() ?? "",
              updatedAt: e.updatedAt?.toString() ?? "",
            });
          }
        }
      }

      return { entities, relationships };
    } finally {
      await session.close();
    }
  }

  /**
   * Merge two entities (for entity resolution).
   * Moves all relationships from source to target and deletes source.
   */
  async mergeEntities(params: {
    orgId: string;
    sourceEntityId: string;
    targetEntityId: string;
  }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite(async (tx) => {
        // Move all outgoing relationships from source to target
        await tx.run(
          `
MATCH (source:Entity {orgId: $orgId, entityId: $sourceEntityId})
MATCH (target:Entity {orgId: $orgId, entityId: $targetEntityId})
MATCH (source)-[r:RELATES_TO]->(other)
MERGE (target)-[newR:RELATES_TO {relationshipType: r.relationshipType}]->(other)
  ON CREATE SET newR = properties(r)
DELETE r
          `,
          params
        );

        // Move all incoming relationships from source to target
        await tx.run(
          `
MATCH (source:Entity {orgId: $orgId, entityId: $sourceEntityId})
MATCH (target:Entity {orgId: $orgId, entityId: $targetEntityId})
MATCH (other)-[r:RELATES_TO]->(source)
MERGE (other)-[newR:RELATES_TO {relationshipType: r.relationshipType}]->(target)
  ON CREATE SET newR = properties(r)
DELETE r
          `,
          params
        );

        // Move file extraction links
        await tx.run(
          `
MATCH (source:Entity {orgId: $orgId, entityId: $sourceEntityId})
MATCH (target:Entity {orgId: $orgId, entityId: $targetEntityId})
MATCH (source)-[r:EXTRACTED_FROM]->(f:File)
MERGE (target)-[newR:EXTRACTED_FROM]->(f)
  ON CREATE SET newR = properties(r)
DELETE r
          `,
          params
        );

        // Delete source entity
        await tx.run(
          `
MATCH (source:Entity {orgId: $orgId, entityId: $sourceEntityId})
DETACH DELETE source
          `,
          params
        );
      });
    } finally {
      await session.close();
    }
  }
}
