import { router, procedure } from "../trpc";
import { z } from "zod";
import { getNeo4jDriver, TypeRegistryRepository, EntityRepository } from "@tiwi/neo4j";

export const schemaRouter = router({
  listTypes: procedure
    .query(async ({ ctx }) => {
      const driver = getNeo4jDriver();
      const typeRepo = new TypeRegistryRepository(driver);
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
      const driver = getNeo4jDriver();
      const typeRepo = new TypeRegistryRepository(driver);
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
      const driver = getNeo4jDriver();
      const typeRepo = new TypeRegistryRepository(driver);
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
      const driver = getNeo4jDriver();
      const typeRepo = new TypeRegistryRepository(driver);
      await typeRepo.deleteType({ orgId: ctx.orgId, typeName: input.typeName });
      return { ok: true };
    }),

  confirmDraftType: procedure
    .input(z.object({ typeName: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const driver = getNeo4jDriver();
      const typeRepo = new TypeRegistryRepository(driver);
      await typeRepo.confirmDraftType({ orgId: ctx.orgId, typeName: input.typeName });
      return { ok: true };
    }),

  dismissDraftType: procedure
    .input(z.object({ typeName: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const driver = getNeo4jDriver();
      const typeRepo = new TypeRegistryRepository(driver);
      const entityRepo = new EntityRepository(driver);
      // Delete entities of this type first, then remove the type
      await entityRepo.deleteEntitiesByType({ orgId: ctx.orgId, typeName: input.typeName });
      await typeRepo.dismissDraftType({ orgId: ctx.orgId, typeName: input.typeName });
      return { ok: true };
    }),
});
