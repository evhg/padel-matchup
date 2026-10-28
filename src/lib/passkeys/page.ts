import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { baseUrl, passkeyAutofillOn } from "@/lib/config";
import { sessionSecret } from "@/lib/env";
import type { PageSignInOptions } from "./caps";

/**
 * The page's own passkey challenge, for the autofill on the player's own name field (the owner, 28
 * October 2026: "May the player's own name field offer a saved passkey above the keyboard ('Tim', then
 * Face ID)?" — "Yes, own name field (Recommended)").
 *
 * A conditional request must be waiting before the player taps the field, and a call to the server for
 * its options on every anonymous view would cost one function call a view (rule 12). So the page carries
 * the challenge itself: 32 random bytes and an expiry ten minutes ahead, sealed with an HMAC under its
 * own purpose, "passkey-page", with no database read. The phone signs the challenge as it is; the sign-in
 * action reads it back out of the answer, checks the seal, the purpose and the expiry, and spends it once
 * on the same row the options call's challenge uses (`spendChallenge`), before anything signs in.
 *
 * This module never imports @simplewebauthn/server, so a page that renders the options carries none of it
 * (src/lib/passkeys/webauthn.ts is the one module that does).
 */

export const PAGE_PURPOSE = "passkey-page";
/** How long a page's challenge signs in: ten minutes after the page was made. */
export const PAGE_TTL_MS = 10 * 60_000;

/** The relying party: the app's own host and origin (`baseUrl`): kicksma.sh in production, localhost in the browser suites. */
export function relyingParty(): { rpID: string; origin: string } {
  const u = new URL(baseUrl());
  return { rpID: u.hostname, origin: u.origin };
}

const PURPOSE = /^[a-z][a-z-]{0,31}$/;
/** 32 bytes in base64url: 43 characters. */
const NONCE = /^[A-Za-z0-9_-]{43}$/;
/** A whole seal is about 150 characters; anything far longer is not one. */
const MAX_CHALLENGE = 300;

/** A key of each purpose's own, derived from the session secret, so no other seal of the app can ever pass for this one. */
const keyFor = (purpose: string) => createHmac("sha256", sessionSecret()).update(`kicksmash-seal:${purpose}`).digest();
const signature = (purpose: string, nonce: string, exp: string) => createHmac("sha256", keyFor(purpose)).update(`${nonce}.${exp}`).digest();

/**
 * A new challenge: `<purpose>.<nonce>.<expiry>.<signature>` in base64url, the form WebAuthn carries a
 * challenge in, so the client data the phone signs holds it unchanged. `purpose` is for the tests of
 * "another purpose is refused"; every caller in the app takes the default.
 */
export function sealPageChallenge(now = new Date(), purpose: string = PAGE_PURPOSE): string {
  const nonce = randomBytes(32).toString("base64url");
  const exp = String(now.getTime() + PAGE_TTL_MS);
  const sig = signature(purpose, nonce, exp).toString("base64url");
  return Buffer.from(`${purpose}.${nonce}.${exp}.${sig}`, "utf8").toString("base64url");
}

/** What a challenge is: a page's own seal still inside its ten minutes, one past them, or anything else. */
export type PageSeal = { state: "open"; challenge: string; expiresAt: Date } | { state: "expired" } | { state: "none" };

/** The parts of a seal the server made for `purpose`, at any age; null for anything else. */
function sealParts(value: unknown, purpose: string): { exp: number } | null {
  if (typeof value !== "string" || !value || value.length > MAX_CHALLENGE || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const parts = Buffer.from(value, "base64url").toString("utf8").split(".");
  if (parts.length !== 4) return null;
  const [own, nonce, exp, sig] = parts;
  if (!PURPOSE.test(own) || !NONCE.test(nonce) || !/^\d{1,16}$/.test(exp)) return null;
  // The signature under the purpose the seal names; then that purpose must be the one asked for.
  const expected = signature(own, nonce, exp);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (own !== purpose) return null;
  return { exp: Number(exp) };
}

/**
 * The page's challenge as the sign-in reads it: `open` while the server's seal for "passkey-page" is
 * inside its ten minutes, `expired` once past them, `none` for anything else (another purpose, a changed
 * value, a plain challenge of the options call).
 */
export function openPageChallenge(value: unknown, now = new Date(), purpose: string = PAGE_PURPOSE): PageSeal {
  const seal = sealParts(value, purpose);
  if (!seal) return { state: "none" };
  if (seal.exp < now.getTime()) return { state: "expired" };
  return { state: "open", challenge: value as string, expiresAt: new Date(seal.exp) };
}

/**
 * What the library checks the challenge inside the signed client data against, for a page's challenge
 * (`expectedChallenge` of `verifyAuthenticationResponse`): the one the sign-in just spent, still a page's
 * own seal for "passkey-page", still inside its ten minutes. A second line: the sign-in read the same
 * client data to find and spend the challenge before the library runs (`signInChallenge` in
 * src/actions/passkeys.ts).
 */
export const pageChallengeCheck =
  (spent: string, now = new Date()) =>
  (signed: string): boolean =>
    signed === spent && openPageChallenge(signed, now).state === "open";

/** Whether a challenge is a page's own seal, at any age: the save of a passkey refuses one, whatever else it checks. */
export const isPageSeal = (value: unknown): boolean => sealParts(value, PAGE_PURPOSE) !== null;

/**
 * The request options a page renders for a browser that knows nobody: the sealed challenge, this host,
 * Face ID or a fingerprint required, and no list of passkeys (the phone offers its own), with the moment
 * the challenge ends, so the browser never hands the phone a stale one. No database read and no call from
 * the browser. Null while `PASSKEY_AUTOFILL` is "off", the kill switch (docs/OPERATING.md).
 */
export function pageSignInOptions(now = new Date()): PageSignInOptions | null {
  if (!passkeyAutofillOn()) return null;
  return { challenge: sealPageChallenge(now), rpId: relyingParty().rpID, userVerification: "required", expiresAt: now.getTime() + PAGE_TTL_MS };
}

/** The challenge the phone signed, out of the answer's client data, unchecked: where the sign-in looks to see which of its two challenges this is. */
export function answerChallenge(answer: unknown): string | null {
  const data = (answer as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON;
  if (typeof data !== "string" || data.length > 4096) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as { challenge?: unknown };
    return typeof parsed?.challenge === "string" && parsed.challenge.length <= MAX_CHALLENGE ? parsed.challenge : null;
  } catch {
    return null;
  }
}
