import { router, procedure } from "../trpc";
import { z } from "zod";
import { ensureGraphMirror } from "@tiwi/core";

export const orgRouter = router({
  ensureGraphMirror: procedure
    .input(z.object({}).optional())
    .mutation(async ({ ctx }) => {
      await ensureGraphMirror({ orgId: ctx.orgId, userId: ctx.userId });
      return { ok: true };
    }),
});

