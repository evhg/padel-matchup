import { after } from "next/server";

/**
 * The platform's own request context. Vercel puts it on `globalThis` under this symbol, with the
 * `waitUntil` that keeps the function alive after the answer, and Next.js reads the same symbol
 * (`getBuiltinRequestContext` in next/dist/server/after/builtin-request-context.js). A self-hosted
 * `next start` sets none, and a test or a script has none either.
 */
const REQUEST_CONTEXT = Symbol.for("@next/request-context");
type RequestStore = { waitUntil?: (p: Promise<unknown>) => void };

function platformStore(): RequestStore | null {
  try {
    const ctx = (globalThis as unknown as Record<symbol, { get?: () => RequestStore | undefined } | undefined>)[REQUEST_CONTEXT];
    const store = ctx?.get?.();
    return store && typeof store.waitUntil === "function" ? store : null;
  } catch {
    return null;
  }
}

/**
 * A counter or an error report that must not delay the response, and must not be lost after it.
 *
 * A bumpMetric or reportError call with `void` in front started the write and let the response go;
 * on a serverless function nothing waits for a promise nobody holds, so the instance can be frozen
 * mid-write and the row never lands. `after()` holds the function open until the work is done, and
 * it is handed the work before this returns, so even a caller that cannot wait leaves nothing loose.
 *
 * `after()` throws outside a request scope. Next.js calls `onRequestError` for a route handler after
 * that scope closed, and sends the 500 only when the hook returns (review, 15 October 2026). So the
 * work then goes to the platform's `waitUntil`, and only where there is none (a test, a script, a
 * self-hosted `next start`) does it run here, for the caller to await. Errors are swallowed either
 * way: this is bookkeeping. `tests/rules.test.ts` fails on the old `void` form anywhere in `src`.
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
    /* no request scope: the platform's waitUntil, else in line */
  }
  const store = platformStore();
  if (store) {
    store.waitUntil!(run());
    return Promise.resolve();
  }
  return run();
}
