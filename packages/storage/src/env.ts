import { z } from "zod";

const StorageEnvSchema = z.object({
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default("auto"),
  S3_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

export type StorageEnv = z.infer<typeof StorageEnvSchema>;

export function getStorageEnv(env: NodeJS.ProcessEnv = process.env): StorageEnv {
  return StorageEnvSchema.parse(env);
}

