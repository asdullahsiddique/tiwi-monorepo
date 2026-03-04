import { z } from "zod";

const StorageEnvSchema = z.object({
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default("us-east-1"),
  // Optional: only needed for local MinIO / non-AWS S3. Omit in production to
  // use the default AWS regional endpoint.
  S3_ENDPOINT: z.string().url().optional(),
  // Optional: omit in production — the ECS task role grants S3 access via IAM.
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

export type StorageEnv = z.infer<typeof StorageEnvSchema>;

export function getStorageEnv(env: NodeJS.ProcessEnv = process.env): StorageEnv {
  return StorageEnvSchema.parse(env);
}

