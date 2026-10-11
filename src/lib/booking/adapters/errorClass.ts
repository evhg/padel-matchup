/**
 * What failed, as the error's class and the network's code ("TypeError ECONNRESET"), never its message:
 * a message may carry the address it failed on. Every reader puts it after its step ("club page:
 * TypeError ECONNRESET"), the shape `failureWhy` in `scrape.ts` keeps; it keeps nothing else when the
 * detail lands in the club's cache.
 */
export function errorClass(e: unknown): string {
  if (!(e instanceof Error)) return "Error";
  const name = /^[A-Z][A-Za-z]{0,39}$/.test(e.name) ? e.name : "Error";
  const code = (e as { cause?: { code?: unknown } }).cause?.code ?? (e as { code?: unknown }).code;
  return `${name}${typeof code === "string" && /^[A-Z_]{1,30}$/.test(code) ? ` ${code}` : ""}`;
}
