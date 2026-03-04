import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone",
  // Tell Next.js to trace files from the monorepo root so workspace packages
  // (@tiwi/*) are included in the standalone output.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  transpilePackages: ["@tiwi/shared", "@tiwi/neo4j", "@tiwi/storage", "@tiwi/core", "@tiwi/enrichment"],
};

export default nextConfig;
