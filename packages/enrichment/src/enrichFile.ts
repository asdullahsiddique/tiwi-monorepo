import OpenAI from "openai";
import { z } from "zod";
import { getLangGraphEnv } from "./env";
import type { EnrichmentResult, EnrichmentContext, ResolvedMatch } from "./types";

const EnrichmentSchema = z.object({
  createdTypes: z
    .array(
      z.object({
        typeName: z.string().min(1).max(64),
        description: z.string().min(1).max(500),
      }),
    )
    .default([]),
  entities: z
    .array(
      z.object({
        typeName: z.string().min(1).max(64),
        name: z.string().min(1).max(256),
        properties: z.record(z.string(), z.unknown()).optional(),
        matchedExistingEntityId: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .default([]),
  relationships: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        relationshipType: z.string().min(1).max(64),
        properties: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
  decisions: z
    .array(
      z.object({
        level: z.enum(["INFO", "WARN"]),
        message: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
  resolvedMatches: z
    .array(
      z.object({
        extractedName: z.string().min(1),
        matchedExistingEntityId: z.string().min(1),
        matchedExistingName: z.string().min(1),
        confidence: z.number().min(0).max(1),
        reason: z.string().min(1),
      }),
    )
    .default([]),
});

/**
 * Normalize common variations in LLM responses to match our schema.
 * Handles cases like: type -> typeName, entity_type -> typeName, etc.
 */
function normalizeEnrichmentResponse(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  
  const obj = raw as Record<string, unknown>;
  const result: Record<string, unknown> = { ...obj };
  
  // Normalize entities array
  if (Array.isArray(obj.entities)) {
    result.entities = obj.entities.map((entity: any) => {
      if (!entity || typeof entity !== "object") return entity;
      const normalized: Record<string, unknown> = { ...entity };
      
      // Handle type/typeName variations
      if (!normalized.typeName && normalized.type) {
        normalized.typeName = normalized.type;
        delete normalized.type;
      }
      if (!normalized.typeName && normalized.entity_type) {
        normalized.typeName = normalized.entity_type;
        delete normalized.entity_type;
      }
      if (!normalized.typeName && normalized.entityType) {
        normalized.typeName = normalized.entityType;
        delete normalized.entityType;
      }
      if (!normalized.typeName && normalized.category) {
        normalized.typeName = normalized.category;
        delete normalized.category;
      }
      if (!normalized.typeName && normalized.label) {
        normalized.typeName = normalized.label;
        delete normalized.label;
      }
      
      // Handle name/value variations
      if (!normalized.name && normalized.value) {
        normalized.name = normalized.value;
        delete normalized.value;
      }
      if (!normalized.name && normalized.entity_name) {
        normalized.name = normalized.entity_name;
        delete normalized.entity_name;
      }
      
      return normalized;
    });
  }
  
  // Normalize createdTypes array
  if (Array.isArray(obj.createdTypes)) {
    result.createdTypes = obj.createdTypes.map((t: any) => {
      if (!t || typeof t !== "object") return t;
      const normalized: Record<string, unknown> = { ...t };
      
      if (!normalized.typeName && normalized.type) {
        normalized.typeName = normalized.type;
        delete normalized.type;
      }
      if (!normalized.typeName && normalized.name) {
        normalized.typeName = normalized.name;
        delete normalized.name;
      }
      
      return normalized;
    });
  }
  
  // Normalize relationships array
  if (Array.isArray(obj.relationships)) {
    result.relationships = obj.relationships.map((rel: any) => {
      if (!rel || typeof rel !== "object") return rel;
      const normalized: Record<string, unknown> = { ...rel };
      
      // Handle from/source variations
      if (!normalized.from && normalized.source) {
        normalized.from = normalized.source;
        delete normalized.source;
      }
      if (!normalized.from && normalized.sourceEntity) {
        normalized.from = normalized.sourceEntity;
        delete normalized.sourceEntity;
      }
      
      // Handle to/target variations
      if (!normalized.to && normalized.target) {
        normalized.to = normalized.target;
        delete normalized.target;
      }
      if (!normalized.to && normalized.targetEntity) {
        normalized.to = normalized.targetEntity;
        delete normalized.targetEntity;
      }
      
      // Handle relationshipType variations
      if (!normalized.relationshipType && normalized.type) {
        normalized.relationshipType = normalized.type;
        delete normalized.type;
      }
      if (!normalized.relationshipType && normalized.relationship) {
        normalized.relationshipType = normalized.relationship;
        delete normalized.relationship;
      }
      if (!normalized.relationshipType && normalized.relation) {
        normalized.relationshipType = normalized.relation;
        delete normalized.relation;
      }
      
      return normalized;
    });
  }
  
  return result;
}

function estimateCostUsd(params: {
  inputTokens: number;
  outputTokens: number;
  priceInputPer1M: number;
  priceOutputPer1M: number;
}): number {
  const input = (params.inputTokens / 1_000_000) * params.priceInputPer1M;
  const output = (params.outputTokens / 1_000_000) * params.priceOutputPer1M;
  return Number((input + output).toFixed(6));
}

/**
 * Format entity types for the prompt.
 */
function formatTypesForPrompt(
  types: Array<{ typeName: string; description: string }>
): string {
  if (types.length === 0) return "No existing types yet.";
  return types
    .map((t) => `- ${t.typeName}: ${t.description}`)
    .join("\n");
}

/**
 * Format existing entities for the prompt.
 */
function formatEntitiesForPrompt(
  entities: Array<{ entityId: string; typeName: string; name: string; mentionCount?: number }>
): string {
  if (entities.length === 0) return "No existing entities yet.";
  return entities
    .map((e) => `- [${e.entityId}] ${e.typeName}: "${e.name}" (${e.mentionCount ?? 1} mentions)`)
    .join("\n");
}

/**
 * Context-aware enrichment that performs entity resolution.
 * If no OpenAI key is configured, returns empty structure with a decision note.
 */
export async function enrichFile(params: {
  orgId: string;
  userId: string;
  fileId: string;
  text: string;
  context?: EnrichmentContext;
}): Promise<EnrichmentResult> {
  const env = getLangGraphEnv();
  const nowIso = new Date().toISOString();

  if (!env.OPENAI_API_KEY) {
    return {
      createdTypes: [],
      entities: [],
      relationships: [],
      resolvedMatches: [],
      aiCalls: [],
      decisions: [
        {
          level: "WARN",
          message: "OPENAI_API_KEY not set; skipping enrichment and returning empty graph.",
          createdAtIso: nowIso,
        },
      ],
    };
  }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const model = env.OPENAI_ENRICHMENT_MODEL;
  
  const existingTypes = params.context?.existingTypes ?? [];
  const existingEntities = params.context?.existingEntities ?? [];
  const hasContext = existingTypes.length > 0 || existingEntities.length > 0;

  const prompt = [
    "You are a knowledge graph builder. Extract entities and relationships from the document.",
    "",
    "=== EXISTING ENTITY TYPES IN THIS ORGANIZATION ===",
    formatTypesForPrompt(existingTypes),
    "",
    "=== EXISTING ENTITIES (check for matches before creating new ones) ===",
    formatEntitiesForPrompt(existingEntities),
    "",
    "=== OUTPUT FORMAT (strict JSON schema) ===",
    "```json",
    "{",
    '  "createdTypes": [{ "typeName": "NewTypeName", "description": "What this type represents" }],',
    '  "entities": [',
    '    {',
    '      "typeName": "Person",',
    '      "name": "John Smith",',
    '      "properties": { "role": "CEO" },',
    '      "matchedExistingEntityId": "abc123",  // IF matched to existing entity',
    '      "confidence": 0.95  // confidence in the extraction',
    '    }',
    '  ],',
    '  "relationships": [{ "from": "John Smith", "to": "Acme Corp", "relationshipType": "WORKS_AT" }],',
    '  "resolvedMatches": [',
    '    {',
    '      "extractedName": "Nerd Camels",',
    '      "matchedExistingEntityId": "abc123",',
    '      "matchedExistingName": "Nerd Camels FZCO",',
    '      "confidence": 0.9,',
    '      "reason": "Same company, abbreviated name"',
    '    }',
    '  ],',
    '  "decisions": [{ "level": "INFO", "message": "Matched 2 entities to existing records" }]',
    "}",
    "```",
    "",
    "=== EXTRACTION RULES ===",
    "1. ENTITY TYPES: Use existing types when possible. Common types include:",
    "   Person, Organization, Location, Event, Invoice, Contract, Document, Project,",
    "   Meeting, Money, Payment, Date, Duration, Product, Service, Technology, Email,",
    "   PhoneNumber, URL, Task, Deadline, Topic, Quote, Concept",
    "2. ONLY create new types in 'createdTypes' if truly novel (not covered above)",
    "3. Every entity MUST have 'typeName' and 'name'",
    "",
    "=== ENTITY RESOLUTION (CRITICAL) ===",
    hasContext
      ? [
          "4. BEFORE creating a new entity, check if it matches an existing one:",
          "   - 'Nerd Camels' matches 'Nerd Camels FZCO' (abbreviation)",
          "   - 'John' might match 'John Smith' if same context",
          "   - 'NYC' matches 'New York City' (common abbreviation)",
          "5. If a match is found:",
          "   - Set 'matchedExistingEntityId' to the existing entity's ID",
          "   - Add entry to 'resolvedMatches' explaining the match",
          "   - Use the EXTRACTED name in 'from'/'to' of relationships",
          "6. If no match found, create new entity (without matchedExistingEntityId)",
        ].join("\n")
      : "4. This is the first extraction - no existing entities to match against.",
    "",
    "=== RELATIONSHIP RULES ===",
    "7. 'from' and 'to' in relationships reference entities by their 'name' field",
    "8. Use clear relationship types: WORKS_AT, ISSUED_BY, BILLED_TO, LOCATED_IN, etc.",
    "",
    "=== DOCUMENT TEXT ===",
    params.text.slice(0, 25_000),
  ].join("\n");

  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You extract structured entities/relationships for a Neo4j knowledge graph. You perform entity resolution to avoid duplicates. Output JSON only.",
      },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(content);
  } catch {
    throw new Error(`LLM returned invalid JSON: ${content.slice(0, 200)}...`);
  }
  
  // Normalize common LLM response variations
  const normalized = normalizeEnrichmentResponse(rawJson);
  
  const parseResult = EnrichmentSchema.safeParse(normalized);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((i) => {
      const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
      return `${path}${i.message} (expected ${(i as any).expected ?? "valid value"}, got ${(i as any).received ?? "invalid"})`;
    });
    throw new Error(`LLM response failed validation: ${issues.join("; ")}`);
  }
  const parsed = parseResult.data;

  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  const totalTokens = response.usage?.total_tokens ?? inputTokens + outputTokens;
  const costUsd = estimateCostUsd({
    inputTokens,
    outputTokens,
    priceInputPer1M: env.OPENAI_PRICE_INPUT_PER_1M_USD,
    priceOutputPer1M: env.OPENAI_PRICE_OUTPUT_PER_1M_USD,
  });

  // Add decision about entity resolution if matches were found
  const decisions = parsed.decisions.map((d) => ({ ...d, createdAtIso: nowIso }));
  if (parsed.resolvedMatches.length > 0) {
    decisions.push({
      level: "INFO" as const,
      message: `Resolved ${parsed.resolvedMatches.length} entities to existing records`,
      createdAtIso: nowIso,
      metadata: {
        matches: parsed.resolvedMatches.map((m) => ({
          from: m.extractedName,
          to: m.matchedExistingName,
        })),
      },
    });
  }

  return {
    createdTypes: parsed.createdTypes,
    entities: parsed.entities,
    relationships: parsed.relationships,
    resolvedMatches: parsed.resolvedMatches,
    decisions,
    aiCalls: [
      {
        model,
        inputTokens,
        outputTokens,
        totalTokens,
        costUsd,
        purpose: "langgraph:file_enrichment",
        createdAtIso: nowIso,
      },
    ],
  };
}

