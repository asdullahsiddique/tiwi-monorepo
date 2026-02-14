import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";
import { startWorker } from "./worker";

// Load env files for local dev (Node doesn't load .env automatically)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, "../.env") });
dotenvConfig({ path: path.resolve(__dirname, "../../.env"), override: false });

async function main() {
  await startWorker();
  // Keep process alive; worker is event-driven
  // eslint-disable-next-line no-console
  console.log("[daemon] worker started");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[daemon] fatal error", err);
  process.exit(1);
});
