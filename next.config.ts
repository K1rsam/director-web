import type { NextConfig } from "next";
const nextConfig: NextConfig = { distDir: process.env.NEXT_DIST_DIR ?? ".next", experimental: { serverActions: { bodySizeLimit: "20mb" } } };
export default nextConfig;
