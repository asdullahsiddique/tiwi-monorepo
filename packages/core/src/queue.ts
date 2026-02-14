import { Queue } from "bullmq";
import { getCoreEnv } from "./env";

export function createQueueConnection(): { connection: { url: string } } {
  const { REDIS_URL } = getCoreEnv();
  return { connection: { url: REDIS_URL } };
}

export function createQueue(name: string): Queue {
  const { connection } = createQueueConnection();
  return new Queue(name, { connection });
}

