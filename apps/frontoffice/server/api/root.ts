import { router } from "./trpc";
import { orgRouter } from "./routers/org";
import { filesRouter } from "./routers/files";
import { searchRouter } from "./routers/search";
import { promptsRouter } from "./routers/prompts";
import { agentRouter } from "./routers/agent";

export const appRouter = router({
  org: orgRouter,
  files: filesRouter,
  search: searchRouter,
  prompts: promptsRouter,
  agent: agentRouter,
});

export type AppRouter = typeof appRouter;
