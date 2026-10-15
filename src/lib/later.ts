import { after } from "next/server";

/**
 * A counter or an error report that must not delay the response, and must not be lost after it.
 *
 * A bumpMetric or reportError call with `void` in front started the write and let the response go;
 * on a serverless function nothing waits for a promise nobody holds, so the instance can be frozen
 * mid-write and the row never lands. `after()` holds the function open until the work is done, and
 * it is handed the work before this returns, so even a caller that cannot wait leaves nothing loose.
 * Outside a request scope (a test, a script) `after()` throws, and the work runs here instead, for
 * the caller to await. Errors are swallowed either way: this is bookkeeping.
 * `tests/rules.test.ts` fails on the old `void` form anywhere in `src`.
 */
export function later(fn: () => Promise<unknown>): Promise<void> {
  const run = async () => {
    try {
      await fn();
    } catch {
      /* bookkeeping never fails the thing it counts */
    }
  };
  try {
    after(run);
    return Promise.resolve();
  } catch {
    return run();
  }
}
