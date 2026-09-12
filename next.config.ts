import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: { '/*': ['./scripts/source_parser.py'] }
};

export default nextConfig;
