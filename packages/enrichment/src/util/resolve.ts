import type { F1LookupStore } from "../f1LookupStore";
import type { EnrichmentState } from "../state";

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Resolve an FK by name: check in-run state first (entities emitted by earlier
 * tier nodes), then fall back to the lookupStore which queries persisted
 * MongoDB data from previous files.
 */
export async function resolveDriverId(
  name: string | undefined,
  state: EnrichmentState,
  lookupStore: F1LookupStore,
): Promise<string | undefined> {
  if (!name) return undefined;
  const n = normalize(name);
  const inRun = state.drivers.find(
    (d) =>
      normalize(d.name) === n ||
      (d.aliases ?? []).some((a) => normalize(a) === n),
  );
  if (inRun) return inRun.entityId;
  const hit = await lookupStore.lookupDriver(name);
  return hit?.entityId;
}

export async function resolveConstructorId(
  name: string | undefined,
  state: EnrichmentState,
  lookupStore: F1LookupStore,
): Promise<string | undefined> {
  if (!name) return undefined;
  const n = normalize(name);
  const inRun = state.constructors.find(
    (c) =>
      normalize(c.name) === n ||
      (c.aliases ?? []).some((a) => normalize(a) === n),
  );
  if (inRun) return inRun.entityId;
  const hit = await lookupStore.lookupConstructor(name);
  return hit?.entityId;
}

export async function resolveCircuitId(
  name: string | undefined,
  state: EnrichmentState,
  lookupStore: F1LookupStore,
): Promise<string | undefined> {
  if (!name) return undefined;
  const n = normalize(name);
  const inRun = state.circuits.find(
    (c) =>
      normalize(c.name) === n ||
      (c.aliases ?? []).some((a) => normalize(a) === n),
  );
  if (inRun) return inRun.entityId;
  const hit = await lookupStore.lookupCircuit(name);
  return hit?.entityId;
}

export async function resolveSeasonIdByYear(
  year: number | undefined,
  state: EnrichmentState,
  lookupStore: F1LookupStore,
): Promise<string | undefined> {
  if (year === undefined) return undefined;
  const inRun = state.seasons.find((s) => s.year === year);
  if (inRun) return inRun.entityId;
  const hit = await lookupStore.lookupSeason(year);
  return hit?.entityId;
}

export async function resolveSeasonIdByName(
  name: string | undefined,
  state: EnrichmentState,
  _lookupStore: F1LookupStore,
): Promise<string | undefined> {
  if (!name) return undefined;
  const n = normalize(name);
  const inRun = state.seasons.find(
    (s) =>
      normalize(s.name) === n ||
      (s.aliases ?? []).some((a) => normalize(a) === n),
  );
  return inRun?.entityId;
}

export async function resolveGrandPrixId(
  name: string | undefined,
  state: EnrichmentState,
  lookupStore: F1LookupStore,
): Promise<string | undefined> {
  if (!name) return undefined;
  const n = normalize(name);
  const inRun = state.grandsPrix.find(
    (g) =>
      normalize(g.name) === n ||
      (g.aliases ?? []).some((a) => normalize(a) === n),
  );
  if (inRun) return inRun.entityId;
  const hit = await lookupStore.lookupGrandPrix(name);
  return hit?.entityId;
}
