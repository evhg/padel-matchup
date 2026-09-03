import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Keep native/wasm drivers out of the webpack bundle; they are loaded from node_modules at runtime.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  // Make sure the OG-image fonts ship with the serverless function.
  outputFileTracingIncludes: {
    "/[code]/opengraph-image": ["./src/lib/og/fonts/*.ttf"],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "1mb",
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
