import { router, procedure } from "../trpc";
import { z } from "zod";
import { semanticSearch } from "@tiwi/core";

export const searchRouter = router({
  semantic: procedure
    .input(
      z.object({
        query: z.string().min(1),
      }),
    )
    .query(async ({ ctx, input }) => {
      const result = await semanticSearch({ orgId: ctx.orgId, query: input.query, topK: 8 });
      return result;
    }),
});

