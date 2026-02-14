import { z } from "zod";

export const TypeNameSchema = z.string().min(1).max(64);
export type TypeName = z.infer<typeof TypeNameSchema>;

export const ExtractedEntitySchema = z.object({
  typeName: TypeNameSchema,
  name: z.string().min(1).max(256),
  properties: z.record(z.string(), z.unknown()).optional(),
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

export type EnrichmentResult = {
  createdTypes: Array<{ typeName: string; description: string }>;
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  aiCalls: AICallUsage[];
  decisions: DecisionLog[];
};

