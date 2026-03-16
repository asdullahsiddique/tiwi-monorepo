import { router } from "./trpc";
import { orgRouter } from "./routers/org";
import { filesRouter } from "./routers/files";
import { searchRouter } from "./routers/search";
import { schemaRouter } from "./routers/schema";

export const appRouter = router({
  org: orgRouter,
  files: filesRouter,
  search: searchRouter,
  schema: schemaRouter,
});

export type AppRouter = typeof appRouter;
