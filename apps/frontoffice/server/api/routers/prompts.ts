import { router, procedure } from "../trpc";
import { z } from "zod";
import { randomUUID } from "crypto";
import { CustomPromptRepository, getMongoDb } from "@tiwi/mongodb";
import { TRPCError } from "@trpc/server";

const PlacementSchema = z.enum(["prepend", "append", "post_process"]);

export const promptsRouter = router({
  list: procedure.query(async ({ ctx }) => {
    const db = await getMongoDb();
    const repo = new CustomPromptRepository(db);
    await repo.ensureIndexes();
    const items = await repo.list({ orgId: ctx.orgId });
    return { items };
  }),

  create: procedure
    .input(
      z.object({
        name: z.string().min(1).max(120),
        description: z.string().max(2000).optional(),
        body: z.string().min(1).max(20_000),
        placement: PlacementSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const repo = new CustomPromptRepository(db);
      await repo.ensureIndexes();
      const record = await repo.create({
        orgId: ctx.orgId,
        promptId: randomUUID(),
        name: input.name,
        description: input.description ?? null,
        body: input.body,
        placement: input.placement,
        createdByUserId: ctx.userId,
      });
      return record;
    }),

  update: procedure
    .input(
      z.object({
        promptId: z.string().min(1),
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(2000).nullable().optional(),
        body: z.string().min(1).max(20_000).optional(),
        placement: PlacementSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const repo = new CustomPromptRepository(db);
      const updated = await repo.update({
        orgId: ctx.orgId,
        promptId: input.promptId,
        name: input.name,
        description: input.description,
        body: input.body,
        placement: input.placement,
      });
      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Prompt not found" });
      }
      return updated;
    }),

  delete: procedure
    .input(z.object({ promptId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const repo = new CustomPromptRepository(db);
      const deleted = await repo.delete({
        orgId: ctx.orgId,
        promptId: input.promptId,
      });
      return { deleted };
    }),
});
