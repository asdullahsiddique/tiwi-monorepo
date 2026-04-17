/**
 * Injected lookup tools for the enrichment graph.
 *
 * Nodes use these to resolve foreign key IDs against already-persisted F1
 * reference entities in MongoDB. In-run lookup (checking entities extracted by
 * earlier nodes in the same graph run) is handled inside each node — the store
 * is only the fallback path.
 */
export type F1LookupResult = {
  entityId: string;
  name: string;
};

export type F1LookupStore = {
  lookupDriver: (name: string) => Promise<F1LookupResult | null>;
  lookupConstructor: (name: string) => Promise<F1LookupResult | null>;
  lookupCircuit: (name: string) => Promise<F1LookupResult | null>;
  lookupSeason: (year: number) => Promise<F1LookupResult | null>;
  lookupGrandPrix: (name: string) => Promise<F1LookupResult | null>;
};

/** No-op store for unit tests / environments without MongoDB. */
export const NOOP_LOOKUP_STORE: F1LookupStore = {
  lookupDriver: async () => null,
  lookupConstructor: async () => null,
  lookupCircuit: async () => null,
  lookupSeason: async () => null,
  lookupGrandPrix: async () => null,
};
