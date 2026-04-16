import { getMongoDb, OrgRepository } from "@tiwi/mongodb";

export async function ensureGraphMirror(params: {
  orgId: string;
  userId: string;
}): Promise<void> {
  const db = await getMongoDb();
  const repo = new OrgRepository(db);
  await repo.ensureOrgAndUser(params);
}
