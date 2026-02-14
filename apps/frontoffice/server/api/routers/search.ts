import { router, procedure } from "../trpc";
import { z } from "zod";
import { semanticSearch } from "@tiwi/core";
import { SearchHistoryRepository, getNeo4jDriver } from "@tiwi/neo4j";
import { randomUUID } from "crypto";

const searchHistoryRepo = new SearchHistoryRepository(getNeo4jDriver());

export const searchRouter = router({
  semantic: procedure
    .input(
      z.object({
        query: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await semanticSearch({ orgId: ctx.orgId, query: input.query, topK: 8 });

      // Save to history
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
      const deleted = await searchHistoryRepo.deleteSearch({
        orgId: ctx.orgId,
        userId: ctx.userId,
        searchId: input.searchId,
      });
      return { deleted };
    }),

  clearHistory: procedure.mutation(async ({ ctx }) => {
    const count = await searchHistoryRepo.clearHistory({
      orgId: ctx.orgId,
      userId: ctx.userId,
    });
    return { deleted: count };
  }),
});

