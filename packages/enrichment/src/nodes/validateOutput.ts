import type { EnrichmentState } from "../state";
import type { DecisionLog, ExtractedRelationship } from "../types";

/**
 * Validate the final output of the enrichment graph.
 * Checks for:
 * - All relationship endpoints exist in entities
 * - No duplicate entities
 * - No duplicate relationships
 */
export async function validateOutput(
  state: EnrichmentState
): Promise<Partial<EnrichmentState>> {
  const now = new Date().toISOString();
  const decisions: DecisionLog[] = [];

  // Build set of valid entity keys
  const entityKeys = new Set(
    state.entities.map((e) => `${e.typeName}:${e.name.toLowerCase()}`)
  );

  // Check for duplicate entities
  const uniqueEntities = new Map<string, boolean>();
  for (const entity of state.entities) {
    const key = `${entity.typeName}:${entity.name.toLowerCase()}`;
    if (uniqueEntities.has(key)) {
      decisions.push({
        level: "WARN",
        message: `Duplicate entity detected: ${entity.typeName}:${entity.name}`,
        createdAtIso: now,
      });
    }
    uniqueEntities.set(key, true);
  }

  // Validate relationships
  const validRelationships: ExtractedRelationship[] = [];
  const invalidRelationships: { rel: ExtractedRelationship; reason: string }[] = [];

  for (const rel of state.relationships) {
    const fromKey = `${rel.fromTypeName}:${rel.fromName.toLowerCase()}`;
    const toKey = `${rel.toTypeName}:${rel.toName.toLowerCase()}`;

    const issues: string[] = [];

    if (!entityKeys.has(fromKey)) {
      issues.push(`Source entity not found: ${rel.fromTypeName}:${rel.fromName}`);
    }
    if (!entityKeys.has(toKey)) {
      issues.push(`Target entity not found: ${rel.toTypeName}:${rel.toName}`);
    }
    if (fromKey === toKey) {
      issues.push("Self-referential relationship");
    }

    if (issues.length > 0) {
      invalidRelationships.push({ rel, reason: issues.join("; ") });
    } else {
      validRelationships.push(rel);
    }
  }

  // Log invalid relationships
  for (const { rel, reason } of invalidRelationships) {
    decisions.push({
      level: "WARN",
      message: `Invalid relationship removed: ${rel.fromName} -[${rel.relationshipType}]-> ${rel.toName}. Reason: ${reason}`,
      createdAtIso: now,
    });
  }

  // Check for duplicate relationships
  const seenRelationships = new Set<string>();
  const deduplicatedRelationships: ExtractedRelationship[] = [];

  for (const rel of validRelationships) {
    const key = `${rel.fromTypeName}:${rel.fromName.toLowerCase()}:${rel.relationshipType}:${rel.toTypeName}:${rel.toName.toLowerCase()}`;
    if (!seenRelationships.has(key)) {
      seenRelationships.add(key);
      deduplicatedRelationships.push(rel);
    } else {
      decisions.push({
        level: "WARN",
        message: `Duplicate relationship removed: ${rel.fromName} -[${rel.relationshipType}]-> ${rel.toName}`,
        createdAtIso: now,
      });
    }
  }

  decisions.push({
    level: "INFO",
    message: `Validation complete: ${state.entities.length} entities, ${deduplicatedRelationships.length} relationships`,
    createdAtIso: now,
    metadata: {
      entityCount: state.entities.length,
      relationshipCount: deduplicatedRelationships.length,
      removedRelationships: invalidRelationships.length + (validRelationships.length - deduplicatedRelationships.length),
    },
  });

  // Always pass validation - we don't retry, just clean up the data
  return {
    relationships: deduplicatedRelationships,
    validationPassed: true,
    decisions,
  };
}
