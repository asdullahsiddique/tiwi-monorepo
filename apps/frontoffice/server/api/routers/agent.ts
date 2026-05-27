import { router, procedure } from "../trpc";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  enqueueAgentQuery,
  getAgentQuery,
  getMongoDb,
  type AgentQueryEvent,
  type AgentQueryJobStatus,
} from "@tiwi/mongodb";

const HistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});

export type AgentQueryStatusResponse = {
  status: AgentQueryJobStatus;
  latestActivity: { message: string; ts: string } | null;
  responseMarkdown: string | null;
  failureReason: string | null;
};

function pickLatestActivity(
  events: AgentQueryEvent[],
): { message: string; ts: string } | null {
  if (events.length === 0) return null;
  // Walk backwards for the most recent event with a non-empty message.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.message && ev.message.trim().length > 0) {
      const ts =
        ev.ts instanceof Date
          ? ev.ts.toISOString()
          : typeof ev.ts === "string"
            ? ev.ts
            : new Date().toISOString();
      return { message: ev.message, ts };
    }
  }
  return null;
}

export const agentRouter = router({
  submitQuery: procedure
    .input(
      z.object({
        conversationId: z.string().min(1).max(120),
        prompt: z.string().min(1).max(8_000),
        history: z.array(HistoryMessageSchema).max(60).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getMongoDb();
      const jobId = randomUUID();
      await enqueueAgentQuery(db, {
        jobId,
        orgId: ctx.orgId,
        userId: ctx.userId,
        conversationId: input.conversationId,
        prompt: input.prompt,
        history: input.history,
      });
      return { jobId };
    }),

  getQueryStatus: procedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ ctx, input }): Promise<AgentQueryStatusResponse> => {
      const db = await getMongoDb();
      const job = await getAgentQuery(db, {
        orgId: ctx.orgId,
        jobId: input.jobId,
      });
      if (!job) {
        return {
          status: "failed",
          latestActivity: null,
          responseMarkdown: null,
          failureReason: "Job not found.",
        };
      }
      return {
        status: job.status,
        latestActivity: pickLatestActivity(job.events ?? []),
        responseMarkdown: job.responseMarkdown ?? null,
        failureReason: job.failureReason ?? null,
      };
    }),
});
