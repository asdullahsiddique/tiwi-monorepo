import type { Driver } from "neo4j-driver";

export type TypeRegistryRecord = {
  orgId: string;
  typeName: string;
  description: string;
  properties: string[];
  status: 'active' | 'draft';
  createdBy: 'user' | 'ai';
  createdAt: string;
  updatedAt: string;
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
        description: props.description ?? "",
        properties: props.properties ?? [],
        status: props.status ?? "active",
        createdBy: props.createdBy ?? "user",
        createdAt: props.createdAt?.toString?.() ?? String(props.createdAt),
        updatedAt: props.updatedAt?.toString?.() ?? props.createdAt?.toString?.() ?? String(props.createdAt),
      };
    } finally {
      await session.close();
    }
  }

  async createType(params: {
    orgId: string;
    typeName: string;
    description: string;
    properties?: string[];
    status?: 'active' | 'draft';
    createdBy?: 'user' | 'ai';
  }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `
MERGE (t:TypeRegistry {orgId: $orgId, typeName: $typeName})
  ON CREATE SET
    t.description = $description,
    t.properties = $properties,
    t.status = $status,
    t.createdBy = $createdBy,
    t.createdAt = datetime(),
    t.updatedAt = datetime()
  ON MATCH SET
    t.description = coalesce(t.description, $description),
    t.properties = coalesce(t.properties, $properties),
    t.status = coalesce(t.status, $status),
    t.createdBy = coalesce(t.createdBy, $createdBy),
    t.updatedAt = datetime()
          `,
          {
            orgId: params.orgId,
            typeName: params.typeName,
            description: params.description,
            properties: params.properties ?? [],
            status: params.status ?? "active",
            createdBy: params.createdBy ?? "user",
          },
        ),
      );
    } finally {
      await session.close();
    }
  }

  async listTypes(params: { orgId: string }): Promise<TypeRegistryRecord[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (t:TypeRegistry {orgId: $orgId})
RETURN t
ORDER BY t.status ASC, t.typeName
          `,
          params,
        ),
      );
      return res.records.map((r) => {
        const props = r.get("t").properties as any;
        return {
          orgId: props.orgId,
          typeName: props.typeName,
          description: props.description ?? "",
          properties: props.properties ?? [],
          status: props.status ?? "active",
          createdBy: props.createdBy ?? "user",
          createdAt: props.createdAt?.toString?.() ?? String(props.createdAt),
          updatedAt: props.updatedAt?.toString?.() ?? props.createdAt?.toString?.() ?? String(props.createdAt),
        };
      });
    } finally {
      await session.close();
    }
  }

  async updateType(params: {
    orgId: string;
    typeName: string;
    description?: string;
    properties?: string[];
  }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `
MATCH (t:TypeRegistry {orgId: $orgId, typeName: $typeName})
SET t.updatedAt = datetime()
${params.description !== undefined ? ", t.description = $description" : ""}
${params.properties !== undefined ? ", t.properties = $properties" : ""}
          `,
          {
            orgId: params.orgId,
            typeName: params.typeName,
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.properties !== undefined ? { properties: params.properties } : {}),
          },
        ),
      );
    } finally {
      await session.close();
    }
  }

  async deleteType(params: { orgId: string; typeName: string }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `
MATCH (t:TypeRegistry {orgId: $orgId, typeName: $typeName})
DETACH DELETE t
          `,
          params,
        ),
      );
    } finally {
      await session.close();
    }
  }

  async confirmDraftType(params: { orgId: string; typeName: string }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `
MATCH (t:TypeRegistry {orgId: $orgId, typeName: $typeName})
SET t.status = 'active', t.updatedAt = datetime()
          `,
          params,
        ),
      );
    } finally {
      await session.close();
    }
  }

  async dismissDraftType(params: { orgId: string; typeName: string }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `
MATCH (t:TypeRegistry {orgId: $orgId, typeName: $typeName})
DETACH DELETE t
          `,
          params,
        ),
      );
    } finally {
      await session.close();
    }
  }
}
