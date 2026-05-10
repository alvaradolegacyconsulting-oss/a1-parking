import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep these out of the server bundle so they can locate their native
  // binaries / shared libraries at runtime via their own resolver. Required
  // for @sparticuz/chromium on Vercel — without this, Next's bundler
  // rewrites internal paths and the Chromium binary can't find libnss3.so.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
};

export default nextConfig;
