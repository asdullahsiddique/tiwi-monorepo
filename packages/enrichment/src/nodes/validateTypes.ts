import type { EnrichmentState } from "../state";
import type { DecisionLog, ProposedType, ExtractedEntity } from "../types";

/**
 * Validate type name format (PascalCase, no special chars).
 */
function isValidTypeName(name: string): boolean {
  // Must be PascalCase: starts with uppercase, alphanumeric only
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

/**
 * Normalize a type name to PascalCase.
 */
function normalizeToPascalCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\s]/g, "") // Remove special chars
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

/**
 * Validate proposed types and filter to only truly new ones.
 * This node checks which proposed types are actually new and should be registered.
 */
export async function validateTypes(
  state: EnrichmentState
): Promise<Partial<EnrichmentState>> {
  const now = new Date().toISOString();
  const decisions: DecisionLog[] = [];

  // If no proposed types, nothing to validate
  if (state.proposedTypes.length === 0) {
    decisions.push({
      level: "INFO",
      message: "No new types proposed, skipping type validation",
      createdAtIso: now,
    });
    return { decisions };
  }

  // Get existing type names (case-insensitive comparison)
  const existingTypeNames = new Set(
    state.existingTypes.map((t) => t.typeName.toLowerCase())
  );

  const validNewTypes: ProposedType[] = [];
  const invalidTypes: { typeName: string; reason: string }[] = [];

  for (const proposed of state.proposedTypes) {
    // Check if type already exists (case-insensitive)
    if (existingTypeNames.has(proposed.typeName.toLowerCase())) {
      decisions.push({
        level: "INFO",
        message: `Type "${proposed.typeName}" already exists, skipping`,
        createdAtIso: now,
      });
      continue;
    }

    // Validate type name format
    if (!isValidTypeName(proposed.typeName)) {
      const normalized = normalizeToPascalCase(proposed.typeName);
      
      if (isValidTypeName(normalized) && !existingTypeNames.has(normalized.toLowerCase())) {
        // Use normalized version
        validNewTypes.push({
          typeName: normalized,
          description: proposed.description,
          suggestedProperties: proposed.suggestedProperties ?? [],
        });
        decisions.push({
          level: "INFO",
          message: `Normalized type name "${proposed.typeName}" to "${normalized}"`,
          createdAtIso: now,
        });
      } else {
        invalidTypes.push({
          typeName: proposed.typeName,
          reason: `Invalid format and normalization to "${normalized}" failed or exists`,
        });
      }
      continue;
    }

    // Validate description exists
    if (!proposed.description || proposed.description.trim().length < 10) {
      invalidTypes.push({
        typeName: proposed.typeName,
        reason: "Description too short (min 10 characters)",
      });
      continue;
    }

    validNewTypes.push(proposed);
  }

  // Log invalid types
  for (const invalid of invalidTypes) {
    decisions.push({
      level: "WARN",
      message: `Rejected proposed type "${invalid.typeName}": ${invalid.reason}`,
      createdAtIso: now,
    });
  }

  // Update entities that use rejected type names to use a generic type
  const validTypeNames = new Set([
    ...state.existingTypes.map((t) => t.typeName),
    ...validNewTypes.map((t) => t.typeName),
  ]);

  const updatedEntities: ExtractedEntity[] = state.entities.map((entity) => {
    // Check if entity's type is valid
    const typeExists = validTypeNames.has(entity.typeName) ||
      [...validTypeNames].some((t) => t.toLowerCase() === entity.typeName.toLowerCase());

    if (!typeExists) {
      // Check if we can find a matching type (case-insensitive)
      const matchingType = [...validTypeNames].find(
        (t) => t.toLowerCase() === entity.typeName.toLowerCase()
      );

      if (matchingType) {
        decisions.push({
          level: "INFO",
          message: `Corrected entity type "${entity.typeName}" to "${matchingType}"`,
          createdAtIso: now,
        });
        return { ...entity, typeName: matchingType };
      }

      // Use generic "Thing" type for unrecognized types
      decisions.push({
        level: "WARN",
        message: `Entity "${entity.name}" has unknown type "${entity.typeName}", will create type`,
        createdAtIso: now,
      });

      // Add to valid new types if valid format
      if (isValidTypeName(entity.typeName)) {
        validNewTypes.push({
          typeName: entity.typeName,
          description: `Auto-created type for ${entity.typeName} entities`,
          suggestedProperties: [],
        });
      }
    }

    return entity;
  });

  decisions.push({
    level: "INFO",
    message: `Type validation complete: ${validNewTypes.length} new types to register`,
    createdAtIso: now,
    metadata: {
      validNewTypes: validNewTypes.map((t) => t.typeName),
      rejectedCount: invalidTypes.length,
    },
  });

  return {
    proposedTypes: validNewTypes,
    createdTypes: validNewTypes, // These will be registered in the graph execution
    entities: updatedEntities,
    decisions,
  };
}
