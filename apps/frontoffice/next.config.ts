import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@tiwi/shared", "@tiwi/neo4j", "@tiwi/storage", "@tiwi/core"],
};

export default nextConfig;
