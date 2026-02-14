import { router } from "./trpc";
import { orgRouter } from "./routers/org";
import { filesRouter } from "./routers/files";
import { searchRouter } from "./routers/search";

export const appRouter = router({
  org: orgRouter,
  files: filesRouter,
  search: searchRouter,
});

export type AppRouter = typeof appRouter;

