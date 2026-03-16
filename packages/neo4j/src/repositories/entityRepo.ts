import type { Driver, ManagedTransaction, Integer } from "neo4j-driver";
import neo4j from "neo4j-driver";

/**
 * Safely convert a Neo4j value to a number.
 * Handles Integer objects, plain numbers, and null/undefined.
 */
function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (neo4j.isInt(value)) return (value as Integer).toNumber();
  return Number(value) || 0;
}

/**
 * Reserved system labels that cannot be used as entity types.
 * These labels are used by the core graph schema.
 */
const RESERVED_LABELS = new Set([
  "Organization", // Tenant org nodes
  "User",         // User nodes  
  "File",         // File nodes
  "Chunk",        // Embedding chunks
  "FileLog",      // Processing logs
  "TypeRegistry", // Type definitions
]);

/**
 * Sanitize and prefix a label name for use as an entity type in Cypher queries.
 * Prefixes with "E_" to avoid collision with system labels like :Organization, :File, etc.
 * Labels must be valid identifiers (alphanumeric + underscore, starting with letter).
 */
function sanitizeLabel(label: string): string {
  // Remove any non-alphanumeric characters except underscore
  let sanitized = label.replace(/[^a-zA-Z0-9_]/g, "");
  // Ensure it starts with a letter
  if (!/^[a-zA-Z]/.test(sanitized)) {
    sanitized = `X${sanitized}`;
  }
  // Prefix all entity labels with E_ to avoid collision with system labels
  return `E_${sanitized}`;
}

/**
 * Get all registered type labels for querying.
 * Returns a Cypher WHERE clause fragment.
 */
function buildTypeLabelsFilter(types: string[]): string {
  if (types.length === 0) {
    return "true"; // Match all
  }
  return types.map((t) => `e:${sanitizeLabel(t)}`).join(" OR ");
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
  constructor(private readonly driver: Driver) {}

  /**
   * Get all entity types for an organization (for AI context).
   * Returns both built-in and custom types with counts.
   */
  async getAllEntityTypes(params: { orgId: string }): Promise<EntityType[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      // Get types from TypeRegistry with entity counts
      const typesResult = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (t:TypeRegistry {orgId: $orgId})
OPTIONAL MATCH (e {orgId: $orgId})
WHERE any(label IN labels(e) WHERE label = t.typeName)
RETURN t.typeName AS typeName, t.description AS description, t.isBuiltIn AS isBuiltIn, count(e) AS entityCount
ORDER BY entityCount DESC, typeName
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

      return types;
    } finally {
      await session.close();
    }
  }

  /**
   * Get summary of existing entities for AI context.
   * Returns most-mentioned entities to help AI resolve matches.
   * Queries across all dynamic node labels.
   */
  async getEntitiesSummary(params: {
    orgId: string;
    limit?: number;
  }): Promise<EntitySummary[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    const limit = params.limit ?? 100;
    try {
      // First get all registered types
      const typesResult = await session.executeRead((tx) =>
        tx.run(
          `MATCH (t:TypeRegistry {orgId: $orgId}) RETURN t.typeName AS typeName`,
          { orgId: params.orgId }
        )
      );
      const typeNames = typesResult.records.map((r) => r.get("typeName") as string);

      if (typeNames.length === 0) {
        return [];
      }

      // Query entities across all registered type labels
      // Using UNION to query each type label
      const unionQueries = typeNames.map((typeName) => {
        const label = sanitizeLabel(typeName);
        return `
          MATCH (e:${label} {orgId: $orgId})
          OPTIONAL MATCH (e)-[:EXTRACTED_FROM]->(f:File)
          RETURN e.entityId AS entityId, "${typeName}" AS typeName, e.name AS name, count(f) AS mentionCount
        `;
      });

      const fullQuery = `
        ${unionQueries.join(" UNION ALL ")}
        ORDER BY mentionCount DESC, name
        LIMIT $limit
      `;

      const result = await session.executeRead((tx) =>
        tx.run(fullQuery, { orgId: params.orgId, limit: neo4j.int(limit) })
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
   * Upsert an entity with dynamic node label.
   * Creates (:Person), (:Organization), (:Invoice) etc. based on typeName.
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
    const label = sanitizeLabel(params.typeName);

    try {
      await session.executeWrite(async (tx) => {
        // Upsert entity with dynamic label - match by orgId + name (case-insensitive)
        // Using string interpolation for label (safe because we sanitize it)
        await tx.run(
          `
MERGE (e:${label} {orgId: $orgId, nameLower: toLower($name)})
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
            name: params.name,
            properties: params.properties ? JSON.stringify(params.properties) : null,
          }
        );

        // Link entity to organization
        await tx.run(
          `
MATCH (e:${label} {orgId: $orgId, nameLower: toLower($name)})
MATCH (o:Organization {orgId: $orgId})
MERGE (o)-[:HAS_ENTITY]->(e)
          `,
          { orgId: params.orgId, name: params.name }
        );

        // Link entity to source file
        await tx.run(
          `
MATCH (e:${label} {orgId: $orgId, nameLower: toLower($name)})
MATCH (f:File {orgId: $orgId, fileId: $fileId})
MERGE (e)-[r:EXTRACTED_FROM]->(f)
  ON CREATE SET r.confidence = $confidence, r.createdAt = datetime()
          `,
          {
            orgId: params.orgId,
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
   * Create a relationship between two entities with dynamic relationship type.
   * Entities are matched by name (case-insensitive) across all type labels.
   * Uses APOC for dynamic relationship type creation.
   */
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
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    const fromLabel = sanitizeLabel(params.fromTypeName);
    const toLabel = sanitizeLabel(params.toTypeName);
    const relType = sanitizeLabel(params.relationshipType);

    try {
      await session.executeWrite(async (tx) => {
        // Create relationship with dynamic type using string interpolation
        // Both labels and relationship type are sanitized
        await tx.run(
          `
MATCH (from:${fromLabel} {orgId: $orgId, nameLower: toLower($fromName)})
MATCH (to:${toLabel} {orgId: $orgId, nameLower: toLower($toName)})
MERGE (from)-[r:${relType}]->(to)
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
   * Queries across all registered type labels.
   */
  async getEntitiesByFile(params: {
    orgId: string;
    fileId: string;
  }): Promise<EntityRecord[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      // First get all registered types
      const typesResult = await session.executeRead((tx) =>
        tx.run(
          `MATCH (t:TypeRegistry {orgId: $orgId}) RETURN t.typeName AS typeName`,
          { orgId: params.orgId }
        )
      );
      const typeNames = typesResult.records.map((r) => r.get("typeName") as string);

      if (typeNames.length === 0) {
        return [];
      }

      // Query entities from each type label that are linked to this file
      const unionQueries = typeNames.map((typeName) => {
        const label = sanitizeLabel(typeName);
        return `
          MATCH (e:${label} {orgId: $orgId})-[:EXTRACTED_FROM]->(f:File {orgId: $orgId, fileId: $fileId})
          RETURN e.orgId AS orgId, e.entityId AS entityId, "${typeName}" AS typeName, e.name AS name, 
                 e.properties AS properties, e.createdAt AS createdAt, e.updatedAt AS updatedAt
        `;
      });

      const fullQuery = `${unionQueries.join(" UNION ALL ")} ORDER BY typeName, name`;

      const result = await session.executeRead((tx) =>
        tx.run(fullQuery, { orgId: params.orgId, fileId: params.fileId })
      );

      return result.records.map((r) => ({
        orgId: r.get("orgId"),
        entityId: r.get("entityId"),
        typeName: r.get("typeName"),
        name: r.get("name"),
        properties: r.get("properties") ? JSON.parse(r.get("properties")) : {},
        createdAt: r.get("createdAt")?.toString() ?? "",
        updatedAt: r.get("updatedAt")?.toString() ?? "",
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Get all relationships extracted from a specific file.
   * Queries across all relationship types.
   */
  async getRelationshipsByFile(params: {
    orgId: string;
    fileId: string;
  }): Promise<RelationshipRecord[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      // Query all relationships that have the sourceFileId property
      const result = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (from {orgId: $orgId})-[r {sourceFileId: $fileId}]->(to {orgId: $orgId})
WHERE r.relationshipId IS NOT NULL
RETURN r.relationshipId AS relationshipId,
       from.entityId AS fromEntityId, labels(from)[0] AS fromTypeName, from.name AS fromName,
       to.entityId AS toEntityId, labels(to)[0] AS toTypeName, to.name AS toName,
       type(r) AS relationshipType, r.properties AS properties, r.createdAt AS createdAt
ORDER BY relationshipType, fromName
          `,
          { orgId: params.orgId, fileId: params.fileId }
        )
      );

      return result.records.map((r) => ({
        relationshipId: r.get("relationshipId"),
        fromEntityId: r.get("fromEntityId"),
        fromTypeName: r.get("fromTypeName"),
        fromName: r.get("fromName"),
        toEntityId: r.get("toEntityId"),
        toTypeName: r.get("toTypeName"),
        toName: r.get("toName"),
        relationshipType: r.get("relationshipType"),
        properties: r.get("properties") ? JSON.parse(r.get("properties")) : {},
        createdAt: r.get("createdAt")?.toString() ?? "",
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Get entity by name (case-insensitive match).
   * If typeName is provided, searches only that label.
   * Otherwise searches across all registered types.
   */
  async getEntityByName(params: {
    orgId: string;
    name: string;
    typeName?: string;
  }): Promise<EntityRecord | null> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      if (params.typeName) {
        const label = sanitizeLabel(params.typeName);
        const result = await session.executeRead((tx) =>
          tx.run(
            `
MATCH (e:${label} {orgId: $orgId, nameLower: toLower($name)})
RETURN e.orgId AS orgId, e.entityId AS entityId, "${params.typeName}" AS typeName, e.name AS name,
       e.properties AS properties, e.createdAt AS createdAt, e.updatedAt AS updatedAt
            `,
            { orgId: params.orgId, name: params.name }
          )
        );

        if (result.records.length === 0) return null;
        const r = result.records[0];
        return {
          orgId: r.get("orgId"),
          entityId: r.get("entityId"),
          typeName: r.get("typeName"),
          name: r.get("name"),
          properties: r.get("properties") ? JSON.parse(r.get("properties")) : {},
          createdAt: r.get("createdAt")?.toString() ?? "",
          updatedAt: r.get("updatedAt")?.toString() ?? "",
        };
      }

      // Search across all registered types
      const typesResult = await session.executeRead((tx) =>
        tx.run(
          `MATCH (t:TypeRegistry {orgId: $orgId}) RETURN t.typeName AS typeName`,
          { orgId: params.orgId }
        )
      );
      const typeNames = typesResult.records.map((r) => r.get("typeName") as string);

      for (const typeName of typeNames) {
        const label = sanitizeLabel(typeName);
        const result = await session.executeRead((tx) =>
          tx.run(
            `
MATCH (e:${label} {orgId: $orgId, nameLower: toLower($name)})
RETURN e.orgId AS orgId, e.entityId AS entityId, "${typeName}" AS typeName, e.name AS name,
       e.properties AS properties, e.createdAt AS createdAt, e.updatedAt AS updatedAt
LIMIT 1
            `,
            { orgId: params.orgId, name: params.name }
          )
        );

        if (result.records.length > 0) {
          const r = result.records[0];
          return {
            orgId: r.get("orgId"),
            entityId: r.get("entityId"),
            typeName: r.get("typeName"),
            name: r.get("name"),
            properties: r.get("properties") ? JSON.parse(r.get("properties")) : {},
            createdAt: r.get("createdAt")?.toString() ?? "",
            updatedAt: r.get("updatedAt")?.toString() ?? "",
          };
        }
      }

      return null;
    } finally {
      await session.close();
    }
  }

  /**
   * Get related entities via graph traversal.
   * Traverses all relationship types.
   */
  async getRelatedEntities(params: {
    orgId: string;
    entityId: string;
    typeName: string;
    depth?: number;
  }): Promise<{ entities: EntityRecord[]; relationships: RelationshipRecord[] }> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    const depth = params.depth ?? 2;
    const label = sanitizeLabel(params.typeName);

    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (start:${label} {orgId: $orgId, entityId: $entityId})
CALL {
  WITH start
  MATCH path = (start)-[*1..${depth}]-(related {orgId: $orgId})
  WHERE related.entityId IS NOT NULL
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
            const labels = node.labels?.filter((l: string) => l !== "Entity") ?? [];
            entities.push({
              orgId: e.orgId,
              entityId: e.entityId,
              typeName: labels[0] ?? "Unknown",
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
    sourceTypeName: string;
    targetEntityId: string;
    targetTypeName: string;
  }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    const sourceLabel = sanitizeLabel(params.sourceTypeName);
    const targetLabel = sanitizeLabel(params.targetTypeName);

    try {
      await session.executeWrite(async (tx) => {
        // Move all outgoing relationships from source to target
        await tx.run(
          `
MATCH (source:${sourceLabel} {orgId: $orgId, entityId: $sourceEntityId})
MATCH (target:${targetLabel} {orgId: $orgId, entityId: $targetEntityId})
MATCH (source)-[r]->(other)
WHERE r.relationshipId IS NOT NULL
WITH source, target, other, type(r) AS relType, properties(r) AS relProps
CALL {
  WITH target, other, relType, relProps
  MERGE (target)-[newR:RELATES_TO]->(other)
  SET newR = relProps
}
          `,
          { orgId: params.orgId, sourceEntityId: params.sourceEntityId, targetEntityId: params.targetEntityId }
        );

        // Move all incoming relationships from source to target
        await tx.run(
          `
MATCH (source:${sourceLabel} {orgId: $orgId, entityId: $sourceEntityId})
MATCH (target:${targetLabel} {orgId: $orgId, entityId: $targetEntityId})
MATCH (other)-[r]->(source)
WHERE r.relationshipId IS NOT NULL
WITH source, target, other, type(r) AS relType, properties(r) AS relProps
CALL {
  WITH target, other, relType, relProps
  MERGE (other)-[newR:RELATES_TO]->(target)
  SET newR = relProps
}
          `,
          { orgId: params.orgId, sourceEntityId: params.sourceEntityId, targetEntityId: params.targetEntityId }
        );

        // Move file extraction links
        await tx.run(
          `
MATCH (source:${sourceLabel} {orgId: $orgId, entityId: $sourceEntityId})
MATCH (target:${targetLabel} {orgId: $orgId, entityId: $targetEntityId})
MATCH (source)-[r:EXTRACTED_FROM]->(f:File)
MERGE (target)-[newR:EXTRACTED_FROM]->(f)
  ON CREATE SET newR = properties(r)
DELETE r
          `,
          { orgId: params.orgId, sourceEntityId: params.sourceEntityId, targetEntityId: params.targetEntityId }
        );

        // Delete source entity
        await tx.run(
          `
MATCH (source:${sourceLabel} {orgId: $orgId, entityId: $sourceEntityId})
DETACH DELETE source
          `,
          { orgId: params.orgId, sourceEntityId: params.sourceEntityId }
        );
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Delete all entities of a given type for an organization.
   * Used when dismissing a draft type.
   */
  async deleteEntitiesByType(params: { orgId: string; typeName: string }): Promise<void> {
    const label = sanitizeLabel(params.typeName);
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `
MATCH (e:${label} {orgId: $orgId})
DETACH DELETE e
          `,
          { orgId: params.orgId },
        ),
      );
    } finally {
      await session.close();
    }
  }
}
