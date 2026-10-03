import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  experimental: { serverActions: { bodySizeLimit: "20mb" } },
  outputFileTracingIncludes: { '/*': ['./scripts/source_parser.py', './runtime/storyboard-v4/**/*'] },
  outputFileTracingExcludes: { '/*': ['./.storyboard-stage3/**/*', './.storyboard-stage3-v2/**/*', './.storyboard-v4/**/*', './.production-ledgers/**/*', './.production-workflows/**/*', './.env*', './.local-login*', './prisma/*.db*', './runtime-3008/**/*', './outputs/**/*', './uploads/**/*', './local-backups/**/*', './.planning/**/*', './runtime/**/*.test.mjs', './runtime/**/fixtures/**/*'] }
};
export default nextConfig;
