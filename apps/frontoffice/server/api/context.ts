import { auth } from "@clerk/nextjs/server";
import { TRPCError } from "@trpc/server";

export type TRPCContext = {
  userId: string;
  orgId: string;
};

export async function createTRPCContext(): Promise<TRPCContext> {
  const { userId, orgId } = await auth();

  if (!userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  if (!orgId) {
    // In v1, we require an org for all app operations.
    // The onboarding page is responsible for ensuring an org is created.
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ORG_REQUIRED" });
  }

  return { userId, orgId };
}

