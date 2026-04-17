import { router } from "./trpc";
import { orgRouter } from "./routers/org";
import { filesRouter } from "./routers/files";
import { searchRouter } from "./routers/search";
import { promptsRouter } from "./routers/prompts";

export const appRouter = router({
  org: orgRouter,
  files: filesRouter,
  search: searchRouter,
  prompts: promptsRouter,
});

export type AppRouter = typeof appRouter;
