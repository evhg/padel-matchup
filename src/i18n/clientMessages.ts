import type { Messages, NestedKeyOf } from "next-intl";

/**
 * A part of the catalogue the browser may need: a namespace ("common"), a part of one ("coach.page"),
 * or one message ("coach.minutes"). A typo here is a type error.
 */
export type ClientPath = NestedKeyOf<Messages>;

/**
 * What the root layout gives the browser on every page: nothing. Its own client components
 * (IdentitySync, PwaSetup) and error.tsx translate nothing. A page whose client components translate
 * gives its own list through `withClientMessages` (./withClientMessages.tsx), and
 * tests/client-messages.test.ts reads each list back from the source.
 */
export const ROOT_CLIENT_MESSAGES: readonly ClientPath[] = [];

/**
 * Only the given parts of the catalogue, as a new object. A part already inside a whole namespace that
 * was taken is skipped, and the catalogue itself is never written to: getMessages() hands every request
 * the same object.
 */
export function pickMessages<T extends object>(all: T, paths: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  const made = new Set<object>([out]);
  const byDepth = [...paths].sort((a, b) => a.split(".").length - b.split(".").length);
  for (const p of byDepth) {
    const parts = p.split(".");
    let value: unknown = all;
    for (const part of parts) value = value && typeof value === "object" && part in value ? (value as Record<string, unknown>)[part] : undefined;
    if (value === undefined) continue;
    let dst = out;
    for (const [i, part] of parts.entries()) {
      if (i === parts.length - 1) {
        dst[part] = value;
        break;
      }
      const next = dst[part];
      if (next === undefined) {
        const o: Record<string, unknown> = {};
        made.add(o);
        dst[part] = o;
        dst = o;
      } else if (typeof next === "object" && next !== null && made.has(next)) {
        dst = next as Record<string, unknown>;
      } else {
        // The whole of this part is already taken.
        break;
      }
    }
  }
  return out as Partial<T>;
}
