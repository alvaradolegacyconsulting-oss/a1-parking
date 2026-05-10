import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep these out of the server bundle so they can locate their downloaded
  // binary / shared libraries at runtime via their own resolver. Required
  // for @sparticuz/chromium-min on Vercel — without this, Next's bundler
  // rewrites internal paths and the runtime binary lookup fails.
  serverExternalPackages: ["@sparticuz/chromium-min", "puppeteer-core"],
};

export default nextConfig;
