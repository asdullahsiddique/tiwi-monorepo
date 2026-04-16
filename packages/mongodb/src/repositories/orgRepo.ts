import type { Db } from "mongodb";
import { COLL } from "../collections";

export class OrgRepository {
  constructor(private readonly db: Db) {}

  async ensureOrgAndUser(params: { orgId: string; userId: string }): Promise<void> {
    const now = new Date();
    await this.db.collection(COLL.organizations).updateOne(
      { orgId: params.orgId },
      { $setOnInsert: { orgId: params.orgId, createdAt: now }, $set: { updatedAt: now } },
      { upsert: true },
    );
    await this.db.collection(COLL.users).updateOne(
      { orgId: params.orgId, userId: params.userId },
      { $setOnInsert: { orgId: params.orgId, userId: params.userId, createdAt: now }, $set: { updatedAt: now } },
      { upsert: true },
    );
  }
}
