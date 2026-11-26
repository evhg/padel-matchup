import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isValidShareCode } from "@/lib/codes";
import { sessionSecret } from "@/lib/env";
import { isCodeVerifier, type TikTokToken } from "@/lib/domain/tiktok";

/**
 * What "Share to TikTok" keeps, and where: nothing in the database (the owner's design, 26 November 2026).
 *
 *   km_tiktok        the player's TikTok access token, encrypted (AES-256-GCM), httpOnly, Secure, SameSite=Lax,
 *                    and gone when the token is: about two hours. No refresh token is kept.
 *   km_tiktok_state  the sign-in's state: the match it started from, a random nonce that TikTok sends back as
 *                    `state`, the PKCE code verifier, and an end ten minutes on; encrypted (AES-256-GCM, so the
 *                    verifier stays secret), httpOnly, on /api/tiktok only.
 *   the video ticket the `t` of the address TikTok pulls the reel from: the match and an end one hour on, signed.
 *
 * Every key is derived from the session secret for one purpose, so no seal opens as another, and none of
 * them is the session cookie's own signature.
 */

export const TOKEN_COOKIE = "km_tiktok";
export const STATE_COOKIE = "km_tiktok_state";
export const STATE_PATH = "/api/tiktok";
export const STATE_TTL_MS = 10 * 60_000;
export const TICKET_TTL_MS = 60 * 60_000;

const key = (purpose: string) => createHmac("sha256", sessionSecret()).update(`tiktok:${purpose}:v1`).digest();
const mac = (purpose: string, value: string) => createHmac("sha256", key(purpose)).update(value).digest("base64url");

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The cookie's options. Secure outside development, as the session cookie is. */
export const cookieOptions = (maxAgeSec: number, path = "/") => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path, maxAge: Math.max(0, Math.floor(maxAgeSec)) });

// ---- Sealing: `<version>.<iv>.<ciphertext and tag>`, base64url, AES-256-GCM under the purpose's own key ----

function seal(version: string, purpose: string, value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(purpose), iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final(), c.getAuthTag()]);
  return `${version}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

/** What a seal holds, or null for anything this server did not seal for this purpose (changed, another key, another version). */
function unseal(value: string | null | undefined, version: string, purpose: string, max: number): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length > max) return null;
  const [v, ivRaw, bodyRaw, more] = value.split(".");
  if (v !== version || !ivRaw || !bodyRaw || more !== undefined) return null;
  try {
    const iv = Buffer.from(ivRaw, "base64url");
    const body = Buffer.from(bodyRaw, "base64url");
    if (iv.length !== 12 || body.length < 17) return null;
    const d = createDecipheriv("aes-256-gcm", key(purpose), iv);
    d.setAuthTag(body.subarray(body.length - 16));
    const json = JSON.parse(Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString("utf8")) as unknown;
    return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---- The token ----

/** `t1.<iv>.<ciphertext and tag>`: the token, the account's open id, the granted scopes and the end. */
export function sealToken(token: TikTokToken): string {
  return seal("t1", "token", { a: token.accessToken, o: token.openId, s: token.scopes, e: token.expiresAt });
}

/** The token a cookie holds while it has more than `marginMs` left; null for anything else (changed, another key, run out). */
export function openToken(value: string | null | undefined, now: Date, marginMs = 0): TikTokToken | null {
  const json = unseal(value, "t1", "token", 6000);
  if (!json || typeof json.a !== "string" || typeof json.e !== "number" || !Array.isArray(json.s)) return null;
  if (json.e - marginMs <= now.getTime()) return null;
  return { accessToken: json.a, openId: typeof json.o === "string" ? json.o : "", scopes: json.s.filter((x): x is string => typeof x === "string"), expiresAt: json.e };
}

// ---- The sign-in's state ----

/** A PKCE code verifier: 64 characters of `[A-Za-z0-9_-]`, all within TikTok's unreserved characters (43 to 128). */
export const newCodeVerifier = () => randomBytes(48).toString("base64url");

/**
 * The code challenge of a verifier, as TikTok states it: "You must use hex encoding of SHA256 to generate the code
 * challenge from the code verifier", and "Since we only support S256 as code_challenge_method, use code_challenge =
 * SHA256(code_verifier)"; their sample is `CryptoJS.SHA256(code_verifier).toString(CryptoJS.enc.Hex)`
 * (developers.tiktok.com/doc/login-kit-desktop, read 26 November 2026). Hex, not the base64url of RFC 7636.
 */
export const codeChallenge = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("hex");

/**
 * A fresh state: the nonce goes to TikTok as `state`, the code challenge of a fresh verifier goes on the
 * authorize address (`codeChallenge`), and the cookie keeps the match, the nonce, the verifier and the end,
 * sealed: `s2.<iv>.<ciphertext and tag>`.
 */
export function newState(code: string, now: Date): { nonce: string; verifier: string; cookie: string } {
  const nonce = randomBytes(18).toString("base64url");
  const verifier = newCodeVerifier();
  return { nonce, verifier, cookie: seal("s2", "state", { c: code, n: nonce, v: verifier, e: now.getTime() + STATE_TTL_MS }) };
}

/**
 * The match a callback belongs to, and the verifier its token exchange sends. `code` is null when the cookie is
 * not ours at all; `ok` is true only when this server sealed it, it has not run out, and TikTok sent back its nonce.
 */
export function checkState(cookie: string | null | undefined, returned: string | null, now: Date): { ok: boolean; code: string | null; verifier?: string; why?: "missing" | "expired" | "mismatch" } {
  const json = unseal(cookie, "s2", "state", 600);
  const code = typeof json?.c === "string" && isValidShareCode(json.c) ? json.c : null;
  if (!json || !code || typeof json.n !== "string" || typeof json.v !== "string" || !isCodeVerifier(json.v) || typeof json.e !== "number") return { ok: false, code: null, why: "missing" };
  if (json.e <= now.getTime()) return { ok: false, code, why: "expired" };
  if (typeof returned !== "string" || !same(returned, json.n)) return { ok: false, code, why: "mismatch" };
  return { ok: true, code, verifier: json.v };
}

// ---- The video ticket ----

/** `<end, base 36>.<signature>`: one match's reel, for one hour. */
export function videoTicket(code: string, now: Date): string {
  const end = (now.getTime() + TICKET_TTL_MS).toString(36);
  return `${end}.${mac("video", `${code}:${end}`)}`;
}

/** Whether a ticket is ours, for this match, and has not run out. */
export function videoTicketOk(code: string, ticket: string | null, now: Date): boolean {
  if (typeof ticket !== "string" || ticket.length > 200) return false;
  const [end, sig, more] = ticket.split(".");
  if (!end || !sig || more !== undefined || !/^[0-9a-z]{1,12}$/.test(end)) return false;
  if (!same(sig, mac("video", `${code}:${end}`))) return false;
  return parseInt(end, 36) > now.getTime();
}
