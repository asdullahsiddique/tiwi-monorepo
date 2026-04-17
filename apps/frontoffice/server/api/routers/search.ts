import { router, procedure } from "../trpc";
import { z } from "zod";
import { semanticSearch } from "@tiwi/core";
import { SearchHistoryRepository, getMongoDb } from "@tiwi/mongodb";
import { randomUUID } from "crypto";

export const searchRouter = router({
  semantic: procedure
    .input(
      z.object({
        query: z.string().min(1),
        promptIds: z.array(z.string().min(1)).max(20).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await semanticSearch({
        orgId: ctx.orgId,
        query: input.query,
        topK: 8,
        promptIds: input.promptIds,
      });

      const db = await getMongoDb();
      const searchHistoryRepo = new SearchHistoryRepository(db);

      const searchId = randomUUID();
      await searchHistoryRepo.saveSearch({
        orgId: ctx.orgId,
        userId: ctx.userId,
        searchId,
        query: input.query,
        answer: result.answer,
        citationCount: result.citations.length,
      });

      return { ...result, searchId };
    }),

  history: procedure.query(async ({ ctx }) => {
    const db = await getMongoDb();
    const searchHistoryRepo = new SearchHistoryRepository(db);
    const history = await searchHistoryRepo.getSearchHistory({
      orgId: ctx.orgId,
      userId: ctx.userId,
      limit: 50,
    });
    return history;
  }),

  deleteSearch: procedure
    .input(z.object({ searchId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const searchHistoryRepo = new SearchHistoryRepository(db);
      const deleted = await searchHistoryRepo.deleteSearch({
        orgId: ctx.orgId,
        userId: ctx.userId,
        searchId: input.searchId,
      });
      return { deleted };
    }),

  clearHistory: procedure.mutation(async ({ ctx }) => {
    const db = await getMongoDb();
    const searchHistoryRepo = new SearchHistoryRepository(db);
    const count = await searchHistoryRepo.clearHistory({
      orgId: ctx.orgId,
      userId: ctx.userId,
    });
    return { deleted: count };
  }),
});
