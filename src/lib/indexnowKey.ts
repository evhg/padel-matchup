/**
 * The IndexNow key and its file, with no imports: the middleware reads this on every request for a
 * root `.txt` name, so it must not bring the database or anything else into the edge bundle.
 */

/** A key IndexNow accepts: 8 to 128 letters, digits and dashes. Anything else is no key. */
export function cleanIndexNowKey(raw: string | null | undefined): string | null {
  const k = (raw ?? "").trim();
  return /^[A-Za-z0-9-]{8,128}$/.test(k) ? k : null;
}

/**
 * Where the middleware sends `/<name>.txt`: to the IndexNow route only when the name is this
 * deployment's key, else nowhere (null), so the request reaches its own route. Until 15 October 2026
 * every name of 8 to 128 such characters went to the IndexNow route, which answers 404 for anything
 * but the key, and `/llms-full.txt` was one of them.
 */
export function indexNowPath(pathname: string, key: string | null | undefined): string | null {
  const k = cleanIndexNowKey(key);
  return k && pathname === `/${k}.txt` ? `/indexnow/${k}.txt` : null;
}
