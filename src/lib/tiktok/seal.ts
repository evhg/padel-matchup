import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isValidShareCode } from "@/lib/codes";
import { sessionSecret } from "@/lib/env";
import type { TikTokToken } from "@/lib/domain/tiktok";

/**
 * What "Share to TikTok" keeps, and where: nothing in the database (the owner's design, 26 November 2026).
 *
 *   km_tiktok        the player's TikTok access token, encrypted (AES-256-GCM), httpOnly, Secure, SameSite=Lax,
 *                    and gone when the token is: about two hours. No refresh token is kept.
 *   km_tiktok_state  the sign-in's state: the match it started from, a random nonce that TikTok sends back as
 *                    `state`, and an end ten minutes on; signed (HMAC), httpOnly, on /api/tiktok only.
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

// ---- The token ----

/** `t1.<iv>.<ciphertext and tag>`, base64url. The token, the account's open id, the granted scopes and the end. */
export function sealToken(token: TikTokToken): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key("token"), iv);
  const body = Buffer.concat([c.update(JSON.stringify({ a: token.accessToken, o: token.openId, s: token.scopes, e: token.expiresAt }), "utf8"), c.final(), c.getAuthTag()]);
  return `t1.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

/** The token a cookie holds while it has more than `marginMs` left; null for anything else (changed, another key, run out). */
export function openToken(value: string | null | undefined, now: Date, marginMs = 0): TikTokToken | null {
  if (typeof value !== "string" || value.length > 6000) return null;
  const [v, ivRaw, bodyRaw, more] = value.split(".");
  if (v !== "t1" || !ivRaw || !bodyRaw || more !== undefined) return null;
  try {
    const iv = Buffer.from(ivRaw, "base64url");
    const body = Buffer.from(bodyRaw, "base64url");
    if (iv.length !== 12 || body.length < 17) return null;
    const d = createDecipheriv("aes-256-gcm", key("token"), iv);
    d.setAuthTag(body.subarray(body.length - 16));
    const json = JSON.parse(Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString("utf8")) as { a?: unknown; o?: unknown; s?: unknown; e?: unknown };
    if (typeof json.a !== "string" || typeof json.e !== "number" || !Array.isArray(json.s)) return null;
    if (json.e - marginMs <= now.getTime()) return null;
    return { accessToken: json.a, openId: typeof json.o === "string" ? json.o : "", scopes: json.s.filter((x): x is string => typeof x === "string"), expiresAt: json.e };
  } catch {
    return null;
  }
}

// ---- The sign-in's state ----

/** A fresh state: the nonce goes to TikTok, the cookie keeps `s1.<code>.<end>.<nonce>.<signature>`. */
export function newState(code: string, now: Date): { nonce: string; cookie: string } {
  const nonce = randomBytes(18).toString("base64url");
  const end = String(now.getTime() + STATE_TTL_MS);
  return { nonce, cookie: `s1.${code}.${end}.${nonce}.${mac("state", `${code}:${end}:${nonce}`)}` };
}

/**
 * The match a callback belongs to. `code` is null when the cookie is not ours at all; `ok` is true only
 * when the server signed it, it has not run out, and TikTok sent back its nonce.
 */
export function checkState(cookie: string | null | undefined, returned: string | null, now: Date): { ok: boolean; code: string | null; why?: "missing" | "expired" | "mismatch" } {
  if (typeof cookie !== "string" || cookie.length > 300) return { ok: false, code: null, why: "missing" };
  const [v, code, end, nonce, sig, more] = cookie.split(".");
  if (v !== "s1" || !code || !isValidShareCode(code) || !/^\d{1,16}$/.test(end ?? "") || !nonce || !sig || more !== undefined) return { ok: false, code: null, why: "missing" };
  if (!same(sig, mac("state", `${code}:${end}:${nonce}`))) return { ok: false, code: null, why: "missing" };
  if (Number(end) <= now.getTime()) return { ok: false, code, why: "expired" };
  if (typeof returned !== "string" || !same(returned, nonce)) return { ok: false, code, why: "mismatch" };
  return { ok: true, code };
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
