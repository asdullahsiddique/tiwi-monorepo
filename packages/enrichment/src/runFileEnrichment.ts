import type { EnrichmentResult, EnrichmentContext } from "./types";
import { enrichFile } from "./enrichFile";
import { ensureTypes, type TypeRegistryStore } from "./typeRegistry";

/**
 * v1 orchestration wrapper:
 * - runs enrichment extraction with optional context for entity resolution
 * - applies type registry checks/creation
 * - returns combined structured output + decision logs
 */
export async function runFileEnrichment(params: {
  orgId: string;
  userId: string;
  fileId: string;
  text: string;
  typeRegistryStore: TypeRegistryStore;
  context?: EnrichmentContext;
}): Promise<EnrichmentResult> {
  const extracted = await enrichFile({
    orgId: params.orgId,
    userId: params.userId,
    fileId: params.fileId,
    text: params.text,
    context: params.context,
  });

  const ensured = await ensureTypes({
    orgId: params.orgId,
    userId: params.userId,
    proposedTypes: extracted.createdTypes,
    store: params.typeRegistryStore,
  });

  return {
    ...extracted,
    createdTypes: ensured.createdTypes,
    decisions: [...extracted.decisions, ...ensured.decisions],
  };
}

