import { createHmac } from "node:crypto";

/**
 * What the rate limits count by instead of a caller's address.
 *
 * Every limit that is "per IP" (new identities, restore codes, feedback, the public API and the MCP
 * endpoint, client error reports) wrote the raw address into `metrics_daily`: about 200 rows a day in
 * September 2026, nearly all of them automated clients calling the MCP endpoint. The owner decided on
 * 30 September 2026 (option A) that no raw address is kept: the key is a hash of it, and the rows go
 * after two days (`pruneRateRows` in `src/lib/domain/ratelimit.ts`).
 *
 * The hash is keyed with `SESSION_SECRET`. A plain SHA-256 of an IPv4 address is not private: there
 * are only four billion of them, and hashing every one takes minutes. Without the secret, the key says
 * nothing about the address; with it, the same caller still lands on the same counter, which is all a
 * limit needs.
 */
export function ipKey(ip: string): string {
  const secret = process.env.SESSION_SECRET || "kicksmash-local";
  return createHmac("sha256", secret).update(`ip:${ip}`).digest("hex").slice(0, 16);
}

/**
 * The caller's key from the request headers: the first hop of `x-forwarded-for` (Vercel sets it), else
 * `x-real-ip`, else "unknown", as `ipKey` makes it. Never the address itself.
 */
export function clientKeyFrom(headers: { get(name: string): string | null }): string {
  const ip = (headers.get("x-forwarded-for") ?? headers.get("x-real-ip") ?? "unknown").split(",")[0].trim().slice(0, 64);
  return ipKey(ip);
}
