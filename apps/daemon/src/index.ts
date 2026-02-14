import { startWorker } from "./worker";

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

