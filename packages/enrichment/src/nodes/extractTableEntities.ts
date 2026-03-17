import { z } from "zod";
import OpenAI from "openai";
import type { EnrichmentState } from "../state";
import type { AICallUsage, DecisionLog, ExtractedEntity, ProposedType } from "../types";
import { getLangGraphEnv } from "../env";

// ---------------------------------------------------------------------------
// Markdown table parser (pure — no AI)
// ---------------------------------------------------------------------------

type ParsedTable = { headers: string[]; rows: string[][] };

function parseMarkdownTables(text: string): ParsedTable[] {
  // Matches: header row | separator (---) | 1+ data rows
  const re = /^\|(.+)\|\s*\n\|[-:\s|]+\|\s*\n((?:\|.+\|\s*\n?)+)/gm;
  const tables: ParsedTable[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const headers = m[1]!.split("|").map((h) => h.trim()).filter(Boolean);
    const rows = m[2]!.trim().split("\n").map((r) =>
      r.split("|").map((c) => c.trim()).filter(Boolean),
    );
    // Only keep tables with ≥2 cols, ≥1 row, ≤100 rows
    if (headers.length >= 2 && rows.length >= 1 && rows.length <= 100) {
      tables.push({ headers, rows });
    }
  }
  return tables.slice(0, 15); // Max 15 tables per document
}

// ---------------------------------------------------------------------------
// AI table-to-entity mapping
// ---------------------------------------------------------------------------

// typeName can be top-level (preferred) or per-entity (fallback for models that disagree)
const TableEntitySchema = z.object({
  name: z.string().min(1),
  typeName: z.string().min(1).max(64).optional(),
  properties: z.record(z.unknown()).default({}),
});

const TableMappingSchema = z.object({
  typeName: z.string().min(1).max(64).optional(),
  isNewType: z.boolean().default(false),
  description: z.string().optional(),
  suggestedProperties: z.array(z.string()).default([]),
  entities: z.array(TableEntitySchema),
});

type TableMapping = z.infer<typeof TableMappingSchema>;

/** Resolve a typeName from the top-level field or fall back to the most common per-entity one. */
function resolveTypeName(mapped: TableMapping, headers: string[]): string {
  if (mapped.typeName) return mapped.typeName;
  // Fall back to per-entity typeName (take the first non-empty one)
  const perEntity = mapped.entities.find((e) => e.typeName)?.typeName;
  if (perEntity) return perEntity;
  // Last resort: derive from headers (e.g. "Position | Driver | Team" → "DriverResult")
  return headers.length > 0
    ? headers[0]!.replace(/\s+/g, "") + "Row"
    : "TableRow";
}

const EXPECTED_JSON_SHAPE = `{
  "typeName": "PascalCaseTypeName",
  "isNewType": true,
  "description": "One-sentence description of what each row represents",
  "suggestedProperties": ["prop1", "prop2"],
  "entities": [
    { "name": "<most identifying cell>", "properties": { "<col2>": "<val>", "<col3>": "<val>" } }
  ]
}`;

function buildTableSystemPrompt(existingTypes: EnrichmentState["existingTypes"]): string {
  const shapeNote =
    `\nYou MUST return a JSON object with EXACTLY this shape:\n${EXPECTED_JSON_SHAPE}\n` +
    "All rows represent the SAME entity type — choose ONE typeName for the entire table.\n";

  if (existingTypes.length === 0) {
    return (
      "You are a data extraction assistant. Map ALL rows of this table to Neo4j entities.\n" +
      "No schema is defined — propose an appropriate PascalCase type name based on the table content.\n" +
      "For each row create one entity: name = the most identifying cell, properties = all other columns.\n" +
      shapeNote
    );
  }

  const typesList = existingTypes
    .map(
      (t) =>
        `- ${t.typeName} (properties: ${t.properties?.join(", ") || "none"})\n    ${t.description}`,
    )
    .join("\n");

  return (
    "You are a data extraction assistant. Map ALL rows of this table to Neo4j entities.\n\n" +
    "Active schema types you MUST prefer:\n" +
    typesList +
    "\n\nInstructions:\n" +
    "1. Pick the best-matching type from the active schema. Match column names → property names.\n" +
    "2. If no type fits, propose a new PascalCase type (isNewType: true).\n" +
    "3. For each row create one entity: name = the most identifying cell, properties = all other columns.\n" +
    shapeNote
  );
}

function buildTableUserPrompt(table: ParsedTable): string {
  return (
    `Table headers: ${table.headers.join(" | ")}\n\n` +
    `Rows:\n${table.rows.map((r) => r.join(" | ")).join("\n")}\n\n` +
    "Return the JSON object as specified."
  );
}

function calculateCost(
  inputTokens: number,
  outputTokens: number,
  inputPricePer1M: number,
  outputPricePer1M: number,
): number {
  return (inputTokens * inputPricePer1M + outputTokens * outputPricePer1M) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

export async function extractTableEntities(
  state: EnrichmentState,
): Promise<Partial<EnrichmentState>> {
  const now = new Date().toISOString();
  const decisions: DecisionLog[] = [];
  const aiCalls: AICallUsage[] = [];
  const entities: ExtractedEntity[] = [];
  const proposedTypes: ProposedType[] = [];

  const tables = parseMarkdownTables(state.text);

  decisions.push({
    level: "INFO",
    message: `extractTableEntities: found ${tables.length} markdown table(s) in extracted text`,
    createdAtIso: now,
    metadata: { tableCount: tables.length },
  });

  if (tables.length === 0) {
    return { decisions };
  }

  const env = getLangGraphEnv();
  if (!env.OPENAI_API_KEY) {
    decisions.push({
      level: "WARN",
      message: "OPENAI_API_KEY not set, skipping table entity extraction",
      createdAtIso: now,
    });
    return { decisions };
  }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const systemPrompt = buildTableSystemPrompt(state.existingTypes);

  for (let i = 0; i < tables.length; i++) {
    const table = tables[i]!;
    const callNow = new Date().toISOString();
    try {
      const response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt + "\n\nYou MUST respond with valid JSON only." },
          { role: "user", content: buildTableUserPrompt(table) },
        ],
      });

      const content = response.choices[0]?.message?.content ?? "{}";
      const inputTokens = response.usage?.prompt_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? 0;

      let mapped: TableMapping;
      try {
        mapped = TableMappingSchema.parse(JSON.parse(content));
      } catch (parseErr) {
        decisions.push({
          level: "WARN",
          message: `Table ${i + 1}: failed to parse LLM response — ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          createdAtIso: callNow,
          metadata: { rawContent: content.slice(0, 300) },
        });
        continue;
      }

      aiCalls.push({
        model: "gpt-4o-mini",
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUsd: calculateCost(
          inputTokens,
          outputTokens,
          env.OPENAI_PRICE_INPUT_PER_1M_USD,
          env.OPENAI_PRICE_OUTPUT_PER_1M_USD,
        ),
        purpose: "table_entity_extraction",
        createdAtIso: callNow,
      });

      const typeName = resolveTypeName(mapped, table.headers);

      // Collect proposed type if new
      if (mapped.isNewType && mapped.description) {
        proposedTypes.push({
          typeName,
          description: mapped.description,
          suggestedProperties: mapped.suggestedProperties,
        });
      }

      // Map rows to entities
      for (const row of mapped.entities) {
        entities.push({
          typeName,
          name: row.name,
          properties: row.properties as Record<string, unknown>,
          confidence: 0.85,
        });
      }

      decisions.push({
        level: "INFO",
        message: `Table ${i + 1}: mapped ${mapped.entities.length} rows → ${typeName}${mapped.isNewType ? " (new type)" : ""}`,
        createdAtIso: callNow,
        metadata: {
          typeName,
          isNewType: mapped.isNewType,
          headers: table.headers,
          entityCount: mapped.entities.length,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      decisions.push({
        level: "WARN",
        message: `Table ${i + 1}: extraction failed — ${msg}`,
        createdAtIso: callNow,
      });
    }
  }

  return { entities, proposedTypes, aiCalls, decisions };
}
