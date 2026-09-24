import { describe, expect, it } from "vitest";
import { isDeploySkew, shouldReloadForSkew, SKEW_RELOAD_WINDOW_MS } from "@/lib/deploySkew";

/**
 * The two client errors in the log on 24 September 2026 were both a page from before a deploy: a
 * script chunk and a server action the new deploy no longer had. The error page now reloads once for
 * those, and only once a minute, so a real fault is still shown and logged.
 */
describe("a page from before the deploy", () => {
  it("knows the two errors production logged, and nothing else", () => {
    expect(isDeploySkew("Loading chunk 6331 failed.\n(error: https://kicksma.sh/_next/static/chunks/app/coaches/page-6310de635ee4dc43.js)")).toBe(true);
    expect(isDeploySkew('Server Action "605893422a2d356d6eb8dc7e5f7b02a1879395753c" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action')).toBe(true);
    expect(isDeploySkew("ChunkLoadError: Loading chunk app/layout failed.")).toBe(true);
    for (const real of ["Cannot read properties of undefined (reading 'id')", "Failed query: select 1", "", null, undefined]) expect(isDeploySkew(real)).toBe(false);
  });

  it("reloads once, and not again within a minute", () => {
    const skew = "Loading chunk 12 failed.";
    expect(shouldReloadForSkew(skew, null, 1_000_000)).toBe(true);
    expect(shouldReloadForSkew(skew, 1_000_000, 1_000_000 + 5_000)).toBe(false);
    expect(shouldReloadForSkew(skew, 1_000_000, 1_000_000 + SKEW_RELOAD_WINDOW_MS + 1)).toBe(true);
    expect(shouldReloadForSkew("TypeError: x is not a function", null, 1_000_000)).toBe(false);
  });
});
