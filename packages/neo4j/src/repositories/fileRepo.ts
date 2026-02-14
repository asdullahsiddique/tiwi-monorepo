import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";

export type FileStatus =
  | "UPLOADING"
  | "UPLOADED"
  | "QUEUED"
  | "PROCESSING"
  | "PROCESSED"
  | "FAILED";

export type FileRecord = {
  orgId: string;
  userId: string;
  fileId: string;
  objectKey: string;
  originalName: string;
  contentType: string;
  sizeBytes?: number;
  status: FileStatus;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
};

export class FileRepository {
  constructor(private readonly driver: Driver) {}

  async upsertFile(params: {
    orgId: string;
    userId: string;
    fileId: string;
    objectKey: string;
    originalName: string;
    contentType: string;
    sizeBytes?: number;
    status: FileStatus;
  }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite(async (tx) => {
        // Upsert file node
        await tx.run(
          `
MERGE (f:File {orgId: $orgId, fileId: $fileId})
  ON CREATE SET
    f.createdAt = datetime(),
    f.updatedAt = datetime()
SET
  f.userId = $userId,
  f.objectKey = $objectKey,
  f.originalName = $originalName,
  f.contentType = $contentType,
  f.sizeBytes = $sizeBytes,
  f.status = $status,
  f.updatedAt = datetime()
          `,
          { ...params, sizeBytes: params.sizeBytes ?? null },
        );

        // Ensure org and user exist, then link file (MATCH the file, don't MERGE it again)
        await tx.run(
          `
MERGE (o:Organization {orgId: $orgId})
  ON CREATE SET o.createdAt = datetime(), o.updatedAt = datetime()
  ON MATCH SET o.updatedAt = datetime()
MERGE (u:User {orgId: $orgId, userId: $userId})
  ON CREATE SET u.createdAt = datetime(), u.updatedAt = datetime()
  ON MATCH SET u.updatedAt = datetime()
MERGE (u)-[:MEMBER_OF]->(o)
WITH o
MATCH (f:File {orgId: $orgId, fileId: $fileId})
MERGE (o)-[:OWNS_FILE]->(f)
          `,
          { orgId: params.orgId, userId: params.userId, fileId: params.fileId },
        );
      });
    } finally {
      await session.close();
    }
  }

  async updateStatus(params: {
    orgId: string;
    fileId: string;
    status: FileStatus;
    failureReason?: string;
  }): Promise<void> {
    const session = this.driver.session({ defaultAccessMode: "WRITE" });
    try {
      await session.executeWrite(async (tx) => {
        await tx.run(
          `
MATCH (f:File {orgId: $orgId, fileId: $fileId})
SET f.status = $status,
    f.failureReason = $failureReason,
    f.updatedAt = datetime()
          `,
          {
            orgId: params.orgId,
            fileId: params.fileId,
            status: params.status,
            failureReason: params.failureReason ?? null,
          },
        );
      });
    } finally {
      await session.close();
    }
  }

  async getFile(params: {
    orgId: string;
    fileId: string;
  }): Promise<FileRecord | null> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.executeRead(async (tx) => {
        return tx.run(
          `
MATCH (f:File {orgId: $orgId, fileId: $fileId})
RETURN f
          `,
          params,
        );
      });

      const node = res.records[0]?.get("f");
      if (!node) return null;
      const props = node.properties as any;
      return {
        orgId: props.orgId,
        userId: props.userId,
        fileId: props.fileId,
        objectKey: props.objectKey,
        originalName: props.originalName,
        contentType: props.contentType,
        sizeBytes: props.sizeBytes ?? undefined,
        status: props.status,
        createdAt: props.createdAt?.toString?.() ?? String(props.createdAt),
        updatedAt: props.updatedAt?.toString?.() ?? String(props.updatedAt),
        failureReason: props.failureReason ?? undefined,
      };
    } finally {
      await session.close();
    }
  }

  async listFiles(params: {
    orgId: string;
    limit: number;
    offset: number;
  }): Promise<FileRecord[]> {
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.executeRead(async (tx) => {
        return tx.run(
          `
MATCH (f:File {orgId: $orgId})
RETURN f
ORDER BY f.createdAt DESC
SKIP $offset
LIMIT $limit
          `,
          {
            orgId: params.orgId,
            offset: neo4j.int(params.offset),
            limit: neo4j.int(params.limit),
          },
        );
      });

      return res.records.map((r) => {
        const node = r.get("f");
        const props = node.properties as any;
        return {
          orgId: props.orgId,
          userId: props.userId,
          fileId: props.fileId,
          objectKey: props.objectKey,
          originalName: props.originalName,
          contentType: props.contentType,
          sizeBytes: props.sizeBytes ?? undefined,
          status: props.status,
          createdAt: props.createdAt?.toString?.() ?? String(props.createdAt),
          updatedAt: props.updatedAt?.toString?.() ?? String(props.updatedAt),
          failureReason: props.failureReason ?? undefined,
        };
      });
    } finally {
      await session.close();
    }
  }

  async getFilesByIds(params: {
    orgId: string;
    fileIds: string[];
  }): Promise<FileRecord[]> {
    if (params.fileIds.length === 0) return [];
    const session = this.driver.session({ defaultAccessMode: "READ" });
    try {
      const res = await session.executeRead((tx) =>
        tx.run(
          `
MATCH (f:File {orgId: $orgId})
WHERE f.fileId IN $fileIds
RETURN f
          `,
          params,
        ),
      );

      return res.records.map((r) => {
        const node = r.get("f");
        const props = node.properties as any;
        return {
          orgId: props.orgId,
          userId: props.userId,
          fileId: props.fileId,
          objectKey: props.objectKey,
          originalName: props.originalName,
          contentType: props.contentType,
          sizeBytes: props.sizeBytes ?? undefined,
          status: props.status,
          createdAt: props.createdAt?.toString?.() ?? String(props.createdAt),
          updatedAt: props.updatedAt?.toString?.() ?? String(props.updatedAt),
          failureReason: props.failureReason ?? undefined,
        };
      });
    } finally {
      await session.close();
    }
  }
}
