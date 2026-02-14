import { router, procedure } from "../trpc";
import { z } from "zod";
import { commitUpload, getFile, getFileView, listFiles, requestUpload, reprocessFile } from "@tiwi/core";

export const filesRouter = router({
  requestUpload: procedure
    .input(
      z.object({
        originalName: z.string().min(1),
        contentType: z.string().min(1),
        folder: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return requestUpload({
        orgId: ctx.orgId,
        userId: ctx.userId,
        originalName: input.originalName,
        contentType: input.contentType,
        folder: input.folder,
      });
    }),

  commitUpload: procedure
    .input(
      z.object({
        fileId: z.string().min(1),
        objectKey: z.string().min(1),
        originalName: z.string().min(1),
        contentType: z.string().min(1),
        sizeBytes: z.number().int().nonnegative().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return commitUpload({
        orgId: ctx.orgId,
        userId: ctx.userId,
        fileId: input.fileId,
        objectKey: input.objectKey,
        originalName: input.originalName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
      });
    }),

  list: procedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(25),
          offset: z.number().int().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 25;
      const offset = input?.offset ?? 0;
      const items = await listFiles({ orgId: ctx.orgId, limit, offset });
      return { items };
    }),

  get: procedure
    .input(z.object({ fileId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const file = await getFile({ orgId: ctx.orgId, fileId: input.fileId });
      return { file };
    }),

  getView: procedure
    .input(z.object({ fileId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      return getFileView({ orgId: ctx.orgId, fileId: input.fileId, logsLimit: 100 });
    }),

  reprocess: procedure
    .input(z.object({ fileId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return reprocessFile({
        orgId: ctx.orgId,
        userId: ctx.userId,
        fileId: input.fileId,
      });
    }),
});

