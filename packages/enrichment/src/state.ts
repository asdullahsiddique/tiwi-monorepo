import { Annotation } from "@langchain/langgraph";
import type {
  ExtractedEntity,
  ExtractedRelationship,
  ProposedType,
  ResolvedMatch,
  DecisionLog,
  AICallUsage,
  EntityTypeContext,
  ExistingEntityContext,
} from "./types";

/**
 * LangGraph state annotation for the enrichment workflow.
 * Uses reducers to accumulate entities, relationships, and logs across nodes.
 */
export const EnrichmentStateAnnotation = Annotation.Root({
  // Input fields (set once at the start)
  text: Annotation<string>({
    reducer: (_, b) => b,
    default: () => "",
  }),
  existingTypes: Annotation<EntityTypeContext[]>({
    reducer: (_, b) => b,
    default: () => [],
  }),
  existingEntities: Annotation<ExistingEntityContext[]>({
    reducer: (_, b) => b,
    default: () => [],
  }),

  // Extraction results (accumulated across nodes)
  entities: Annotation<ExtractedEntity[]>({
    reducer: (a, b) => {
      // Merge entities, avoiding duplicates by name+typeName
      const existing = new Set(a.map((e) => `${e.typeName}:${e.name.toLowerCase()}`));
      const newEntities = b.filter(
        (e) => !existing.has(`${e.typeName}:${e.name.toLowerCase()}`)
      );
      return [...a, ...newEntities];
    },
    default: () => [],
  }),
  relationships: Annotation<ExtractedRelationship[]>({
    reducer: (a, b) => {
      // Merge relationships, avoiding duplicates
      const existing = new Set(
        a.map(
          (r) =>
            `${r.fromTypeName}:${r.fromName.toLowerCase()}:${r.relationshipType}:${r.toTypeName}:${r.toName.toLowerCase()}`
        )
      );
      const newRels = b.filter(
        (r) =>
          !existing.has(
            `${r.fromTypeName}:${r.fromName.toLowerCase()}:${r.relationshipType}:${r.toTypeName}:${r.toName.toLowerCase()}`
          )
      );
      return [...a, ...newRels];
    },
    default: () => [],
  }),
  proposedTypes: Annotation<ProposedType[]>({
    reducer: (a, b) => {
      // Merge proposed types, avoiding duplicates by typeName
      const existing = new Set(a.map((t) => t.typeName.toLowerCase()));
      const newTypes = b.filter((t) => !existing.has(t.typeName.toLowerCase()));
      return [...a, ...newTypes];
    },
    default: () => [],
  }),
  resolvedMatches: Annotation<ResolvedMatch[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  createdTypes: Annotation<ProposedType[]>({
    reducer: (a, b) => {
      // Types that were actually created in the TypeRegistry
      const existing = new Set(a.map((t) => t.typeName.toLowerCase()));
      const newTypes = b.filter((t) => !existing.has(t.typeName.toLowerCase()));
      return [...a, ...newTypes];
    },
    default: () => [],
  }),

  // Tracking (accumulated)
  decisions: Annotation<DecisionLog[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  aiCalls: Annotation<AICallUsage[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  errors: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),

  // Control flow
  retryCount: Annotation<number>({
    reducer: (_, b) => b,
    default: () => 0,
  }),
  validationPassed: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
});

export type EnrichmentState = typeof EnrichmentStateAnnotation.State;
export type EnrichmentStateInput = Partial<EnrichmentState>;
