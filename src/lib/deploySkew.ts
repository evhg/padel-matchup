/**
 * A page opened before a deploy asks the new deploy for code it no longer has: a script chunk
 * ("Loading chunk 6331 failed", /coaches, 21 September 2026) or a server action ("Server Action …
 * was not found on the server", /c/dikke-henk, 18 September). Nothing is broken; the page is old.
 * One reload fetches the new one, so the error page reloads instead of showing "Net cord", and
 * nothing is logged. A second one within a minute is a real fault and is shown and logged as usual.
 */
const SKEW = [/Loading chunk [\w-]+ failed/i, /ChunkLoadError/, /Loading CSS chunk/i, /Server Action "?[0-9a-f]+"? was not found on the server/i, /Failed to find Server Action/i];

export const isDeploySkew = (message: string | null | undefined): boolean => Boolean(message) && SKEW.some((r) => r.test(message!));

/** The last reload for skew, so a page that fails again straight after is not reloaded for ever. */
export const SKEW_RELOAD_KEY = "ks_skew_reload";
export const SKEW_RELOAD_WINDOW_MS = 60_000;

/** Whether to reload now: skew, and no reload for it in the last minute. Pure; the caller holds the clock and the storage. */
export function shouldReloadForSkew(message: string | null | undefined, lastReloadAt: number | null, now: number): boolean {
  return isDeploySkew(message) && (lastReloadAt === null || now - lastReloadAt > SKEW_RELOAD_WINDOW_MS);
}
