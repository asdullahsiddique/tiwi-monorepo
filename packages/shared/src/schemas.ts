import { z } from "zod";

export const FileStatusSchema = z.enum([
  "UPLOADING",
  "UPLOADED",
  "QUEUED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
]);
export type FileStatus = z.infer<typeof FileStatusSchema>;

export const FileNodeSchema = z.object({
  orgId: z.string().min(1),
  userId: z.string().min(1),
  fileId: z.string().min(1),
  objectKey: z.string().min(1),
  originalName: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
  status: FileStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FileNode = z.infer<typeof FileNodeSchema>;

export const AIExecutionLogSchema = z.object({
  orgId: z.string().min(1),
  fileId: z.string().min(1).optional(),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  purpose: z.string().min(1),
  createdAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AIExecutionLog = z.infer<typeof AIExecutionLogSchema>;

export const ProcessingLogSchema = z.object({
  orgId: z.string().min(1),
  fileId: z.string().min(1),
  level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]),
  message: z.string().min(1),
  createdAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ProcessingLog = z.infer<typeof ProcessingLogSchema>;

