import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/helpers/setup.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each file gets its own in-memory PGlite, so files run in parallel; TEST_DATABASE_URL is one shared Postgres, so there they run one at a time.
    fileParallelism: !process.env.TEST_DATABASE_URL,
    // Files share a worker, which is what lets tests/helpers/db.ts keep one database per worker
    // instead of standing a new one up for every file. Standing one up costs seconds; emptying it
    // costs milliseconds, and the suite went from about 175 seconds to about 33. The price is that
    // a test must leave no global state behind: what a test sets on process.env, it unsets.
    isolate: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/helpers/server-only.ts"),
    },
  },
});
