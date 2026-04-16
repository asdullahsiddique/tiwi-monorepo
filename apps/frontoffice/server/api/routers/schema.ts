import { router, procedure } from "../trpc";
import { z } from "zod";
import { getMongoDb, TypeRegistryRepository, EntityRepository } from "@tiwi/mongodb";

export const schemaRouter = router({
  listTypes: procedure.query(async ({ ctx }) => {
    const db = await getMongoDb();
    const typeRepo = new TypeRegistryRepository(db);
    const types = await typeRepo.listTypes({ orgId: ctx.orgId });
    return { types };
  }),

  createType: procedure
    .input(
      z.object({
        typeName: z.string().min(1).max(64),
        description: z.string().min(1).max(500),
        properties: z.array(z.string()).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const typeRepo = new TypeRegistryRepository(db);
      await typeRepo.createType({
        orgId: ctx.orgId,
        typeName: input.typeName,
        description: input.description,
        properties: input.properties,
        status: "active",
        createdBy: "user",
      });
      return { ok: true };
    }),

  updateType: procedure
    .input(
      z.object({
        typeName: z.string().min(1).max(64),
        description: z.string().min(1).max(500).optional(),
        properties: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const typeRepo = new TypeRegistryRepository(db);
      await typeRepo.updateType({
        orgId: ctx.orgId,
        typeName: input.typeName,
        description: input.description,
        properties: input.properties,
      });
      return { ok: true };
    }),

  deleteType: procedure
    .input(z.object({ typeName: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const typeRepo = new TypeRegistryRepository(db);
      await typeRepo.deleteType({ orgId: ctx.orgId, typeName: input.typeName });
      return { ok: true };
    }),

  confirmDraftType: procedure
    .input(z.object({ typeName: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const typeRepo = new TypeRegistryRepository(db);
      await typeRepo.confirmDraftType({ orgId: ctx.orgId, typeName: input.typeName });
      return { ok: true };
    }),

  dismissDraftType: procedure
    .input(z.object({ typeName: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const typeRepo = new TypeRegistryRepository(db);
      const entityRepo = new EntityRepository(db);
      await entityRepo.deleteEntitiesByType({ orgId: ctx.orgId, typeName: input.typeName });
      await typeRepo.dismissDraftType({ orgId: ctx.orgId, typeName: input.typeName });
      return { ok: true };
    }),
});
