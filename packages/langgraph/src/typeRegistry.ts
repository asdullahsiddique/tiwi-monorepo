import type { DecisionLog } from "./types";

export type TypeRegistryStore = {
  getType: (params: { orgId: string; typeName: string }) => Promise<
    | {
        typeName: string;
        description: string;
        createdBy: string;
        createdAtIso: string;
      }
    | null
  >;
  createType: (params: {
    orgId: string;
    typeName: string;
    description: string;
    createdBy: string;
  }) => Promise<void>;
};

export async function ensureTypes(params: {
  orgId: string;
  userId: string;
  proposedTypes: Array<{ typeName: string; description: string }>;
  store: TypeRegistryStore;
}): Promise<{
  createdTypes: Array<{ typeName: string; description: string }>;
  decisions: DecisionLog[];
}> {
  const createdTypes: Array<{ typeName: string; description: string }> = [];
  const decisions: DecisionLog[] = [];
  const nowIso = new Date().toISOString();

  for (const t of params.proposedTypes) {
    const existing = await params.store.getType({ orgId: params.orgId, typeName: t.typeName });
    if (existing) {
      decisions.push({
        level: "INFO",
        message: `Reused existing type: ${t.typeName}`,
        createdAtIso: nowIso,
      });
      continue;
    }

    await params.store.createType({
      orgId: params.orgId,
      typeName: t.typeName,
      description: t.description,
      createdBy: params.userId,
    });

    createdTypes.push(t);
    decisions.push({
      level: "INFO",
      message: `Created new type: ${t.typeName}`,
      createdAtIso: nowIso,
      metadata: { description: t.description },
    });
  }

  return { createdTypes, decisions };
}

