import type { EnrichmentResult } from "./types";
import { enrichFile } from "./enrichFile";
import { ensureTypes, type TypeRegistryStore } from "./typeRegistry";

/**
 * v1 orchestration wrapper:
 * - runs enrichment extraction
 * - applies type registry checks/creation
 * - returns combined structured output + decision logs
 */
export async function runFileEnrichment(params: {
  orgId: string;
  userId: string;
  fileId: string;
  text: string;
  typeRegistryStore: TypeRegistryStore;
}): Promise<EnrichmentResult> {
  const extracted = await enrichFile({
    orgId: params.orgId,
    userId: params.userId,
    fileId: params.fileId,
    text: params.text,
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

