import { z } from "zod";

export const TypeNameSchema = z.string().min(1).max(64);
export type TypeName = z.infer<typeof TypeNameSchema>;

export const ExtractedEntitySchema = z.object({
  typeName: TypeNameSchema,
  name: z.string().min(1).max(256),
  properties: z.record(z.string(), z.unknown()).optional(),
  // Entity resolution fields
  matchedExistingEntityId: z.string().optional(), // If matched to existing entity
  confidence: z.number().min(0).max(1).optional(), // Confidence in the match
});
export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;

export const ExtractedRelationshipSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relationshipType: z.string().min(1).max(64),
  properties: z.record(z.string(), z.unknown()).optional(),
});
export type ExtractedRelationship = z.infer<typeof ExtractedRelationshipSchema>;

export type AICallUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  purpose: string;
  createdAtIso: string;
};

export type DecisionLog = {
  level: "INFO" | "WARN";
  message: string;
  createdAtIso: string;
  metadata?: Record<string, unknown>;
};

/**
 * Entity type information for AI context.
 */
export type EntityTypeContext = {
  typeName: string;
  description: string;
  entityCount?: number;
};

/**
 * Existing entity summary for AI context (entity resolution).
 */
export type ExistingEntityContext = {
  entityId: string;
  typeName: string;
  name: string;
  mentionCount?: number;
};

/**
 * Context provided to the enrichment function for entity resolution.
 */
export type EnrichmentContext = {
  existingTypes: EntityTypeContext[];
  existingEntities: ExistingEntityContext[];
};

/**
 * Entity resolution match from AI.
 */
export type ResolvedMatch = {
  extractedName: string;
  matchedExistingEntityId: string;
  matchedExistingName: string;
  confidence: number;
  reason: string;
};

export type EnrichmentResult = {
  createdTypes: Array<{ typeName: string; description: string }>;
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  aiCalls: AICallUsage[];
  decisions: DecisionLog[];
  // Entity resolution results
  resolvedMatches: ResolvedMatch[];
};

