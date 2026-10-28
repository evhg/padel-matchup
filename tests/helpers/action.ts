import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";

/**
 * Calls a server action the way Next.js calls one: inside a request whose cookies it may read and set.
 * A server action is a public endpoint, so a test calls it as a stranger would, with whatever cookies
 * the stranger's browser holds (`jar`), and reads back the cookies the answer leaves in that browser.
 * A deleted cookie comes back absent from `cookies`, and with an empty value in `set`. What the action hands `after()` (and so `later()`) runs once the
 * action has answered, as it does in Next.js, and before this returns. `revalidatePath` is recorded
 * and does nothing else.
 */
export async function asAction<T>(
  jar: Record<string, string>,
  fn: () => Promise<T>,
  o: { headers?: Record<string, string> } = {},
): Promise<{ result: T; cookies: Record<string, string>; set: { name: string; value: string; maxAge?: number; path?: string }[] }> {
  const cookie = Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  // `o.headers`: what else the browser sends (a user agent), lower case as Node gives them.
  const req = { headers: { ...(o.headers ?? {}), ...(cookie ? { cookie, host: "localhost" } : { host: "localhost" }) } };
  const store = createRequestStoreForAPI(req as never, { pathname: "/", search: "" } as never, undefined as never, undefined, undefined as never);
  const tasks: (Promise<unknown> | (() => unknown))[] = [];
  const work = {
    route: "/test-action",
    forceStatic: false,
    dynamicShouldError: false,
    isStaticGeneration: false,
    incrementalCache: {},
    afterContext: { after: (task: Promise<unknown> | (() => unknown)) => void tasks.push(task) },
  };
  const result = await workAsyncStorage.run(work as never, () => workUnitAsyncStorage.run(store as never, fn));
  for (const task of tasks) await workAsyncStorage.run(work as never, async () => (typeof task === "function" ? task() : task)).catch(() => undefined);
  const out: Record<string, string> = {};
  for (const c of store.mutableCookies.getAll()) if (c.value !== "") out[c.name] = c.value;
  // `set`: every cookie the answer wrote, with its life and path; a deleted one is there with an empty value.
  const set = store.mutableCookies.getAll().map((c) => ({ name: c.name, value: c.value, maxAge: c.maxAge, path: c.path }));
  return { result, cookies: out, set };
}
