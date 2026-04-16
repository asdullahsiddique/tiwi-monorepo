import { MongoClient, type Db } from "mongodb";
import { getMongoEnv } from "./env";
import { ensureMongoIndexes } from "./schema";

const globalForMongo = globalThis as unknown as {
  mongoClientPromise?: Promise<MongoClient>;
};

function getClientPromise(env: NodeJS.ProcessEnv = process.env): Promise<MongoClient> {
  if (!globalForMongo.mongoClientPromise) {
    const { MONGODB_URI } = getMongoEnv(env);
    const client = new MongoClient(MONGODB_URI);
    globalForMongo.mongoClientPromise = client.connect();
  }
  return globalForMongo.mongoClientPromise;
}

/**
 * Connected MongoDB database (singleton client per process).
 */
export async function getMongoDb(env: NodeJS.ProcessEnv = process.env): Promise<Db> {
  const client = await getClientPromise(env);
  const db = client.db();
  await ensureMongoIndexes(db);
  return db;
}

export async function closeMongoClient(): Promise<void> {
  if (globalForMongo.mongoClientPromise) {
    const client = await globalForMongo.mongoClientPromise;
    await client.close();
    globalForMongo.mongoClientPromise = undefined;
  }
}
