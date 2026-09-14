import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Standalone output feeds the Dockerfile; Vercel ignores it.
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // Keep native/wasm drivers out of the webpack bundle; they are loaded from node_modules at runtime.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  // Make sure the OG-image fonts ship with the serverless function.
  outputFileTracingIncludes: {
    "/[code]/opengraph-image": ["./src/lib/og/fonts/*.ttf"],
    // Auto-migrate on first connection reads the journal and the SQL, and nothing else. `drizzle/**/*`
    // also shipped drizzle/meta's snapshots — 4.6 MB of drizzle-kit's own bookkeeping, in every
    // function of every deployment, that no runtime has ever opened.
    "/": ["./drizzle/*.sql", "./drizzle/meta/_journal.json"],
    "/**/*": ["./drizzle/*.sql", "./drizzle/meta/_journal.json"],
  },
  // PGlite is the local and test database: 18 MB of WebAssembly Postgres. createPgliteDb() throws
  // before importing it when onVercel(), so on Vercel that import is unreachable by design — but the
  // tracer follows the literal specifier, not the guard above it, and packaged those megabytes into
  // every function. Function storage is metered; this was most of it.
  outputFileTracingExcludes: {
    // "/" needs its own key: "/**/*" wants a path segment, so the landing page — the busiest route
    // there is — kept all 18 MB while every other route shed them. Worth a second look at the numbers
    // rather than the config after a change like this.
    "/": ["**/@electric-sql/pglite/**"],
    "/**/*": ["**/@electric-sql/pglite/**"],
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
