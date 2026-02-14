import type { Driver } from "neo4j-driver";

export type TypeRegistryRecord = {
  orgId: string;
  typeName: string;
  description: string;
  createdBy: string;
  createdAt: string;
};

export class TypeRegistryRepository {
  constructor(private readonly driver: Driver) {}

  async getType(params: { orgId: string; typeName: string }): Promise<TypeRegistryRecord | null> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (t:TypeRegistry {orgId: $orgId, typeName: $typeName})
RETURN t
          `,
          params,
        ),
      );
      const node = res.records[0]?.get("t");
      if (!node) return null;
      const props = node.properties as any;
      return {
        orgId: props.orgId,
        typeName: props.typeName,
        description: props.description,
        createdBy: props.createdBy,
        createdAt: props.createdAt?.toString?.() ?? String(props.createdAt),
      };
    } finally {
      await session.close();
    }
  }

  async createType(params: {
    orgId: string;
    typeName: string;
    description: string;
    createdBy: string;
  }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `
MERGE (t:TypeRegistry {orgId: $orgId, typeName: $typeName})
  ON CREATE SET
    t.description = $description,
    t.createdBy = $createdBy,
    t.createdAt = datetime()
  ON MATCH SET
    t.description = coalesce(t.description, $description),
    t.createdBy = coalesce(t.createdBy, $createdBy)
          `,
          params,
        ),
      );
    } finally {
      await session.close();
    }
  }
}

