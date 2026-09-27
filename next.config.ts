import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: { '/*': ['./scripts/source_parser.py', './runtime/storyboard-v4/**/*'] },
  outputFileTracingExcludes: { '/*': ['./.storyboard-v4/**/*', './.env*', './.local-login.md', './prisma/*.db*', './runtime/**/*.test.mjs', './runtime/**/fixtures/**/*'] }
};

export default nextConfig;
