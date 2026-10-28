import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Db } from "@/db";
import type { Passkey } from "@/db/schema";
import { takeRate } from "@/lib/domain/ratelimit";
import { sessionSecret } from "@/lib/env";
import { isPageSeal, relyingParty } from "./page";

/**
 * The passkey ceremony (DECIDING rule 39): the one module that touches @simplewebauthn/server, so the
 * library lands only in the server actions that import this file (`src/actions/passkeys.ts`), never in
 * a route that does not need it. The rules (who may save one, what a sign-in folds) are
 * src/lib/domain/passkeys.ts.
 *
 * What the server keeps of a ceremony: nothing in the database. The challenge travels in a cookie of
 * its own (`CHALLENGE_COOKIE`), httpOnly, five minutes, signed with the session secret for one purpose
 * (`register` or `signin`) and, for a save, for one player; the action deletes it and spends it
 * (`spendChallenge`) before it checks the answer, so a challenge is used once, also when somebody sends
 * a copy of the cookie again. Nothing here logs a credential id, a public key or a user handle, and a
 * failed query reaches the log without its values (`quietPasskeyError`).
 */

export const RP_NAME = "Kicksmash";
export const CHALLENGE_COOKIE = "km_passkey";
/** How long a challenge stays good: five minutes, as long as the cookie lives. */
export const CHALLENGE_TTL_MS = 5 * 60_000;
export type CeremonyPurpose = "register" | "signin";

/** The relying party, kept beside the page's challenge (src/lib/passkeys/page.ts), which a page renders without this module. */
export { relyingParty };

const hmac = (value: string) => createHmac("sha256", sessionSecret()).update(value).digest();

/**
 * The user handle the phone keeps beside the passkey: an HMAC of the player id with the session
 * secret, 32 bytes. Never stored, never the player id: the same player always gets the same handle, so
 * a second save on the same Apple or Google account replaces the first in the phone's password
 * manager instead of listing the player twice, and the handle says nothing to anybody without the secret.
 */
export function passkeyUserId(playerId: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(32);
  out.set(hmac(`passkey-user:${playerId}`));
  return out;
}

const PLAYER = /^[0-9a-f-]{36}$/i;
/** A challenge: 32 random bytes in base64url (43 characters), with room either side. */
const B64URL = /^[A-Za-z0-9_-]{16,128}$/;
/** A credential id: at most 1023 bytes by the standard, so at most 1364 characters in base64url. */
const CREDENTIAL = /^[A-Za-z0-9_-]{8,1364}$/;

/** The cookie's value for one challenge: `c1.<purpose>.<player or ->.<expiry>.<challenge>.<signature>`. */
export function sealChallenge(purpose: CeremonyPurpose, challenge: string, playerId: string | null, now = new Date()): string {
  const who = playerId ?? "-";
  const exp = String(now.getTime() + CHALLENGE_TTL_MS);
  const sig = hmac(`passkey-challenge:${purpose}:${who}:${exp}:${challenge}`).toString("base64url");
  return `c1.${purpose}.${who}.${exp}.${challenge}.${sig}`;
}

/** A challenge the server sealed, with the moment its five minutes end: the seal's own value, so every use of one challenge names the same moment. */
export type OpenedChallenge = { challenge: string; expiresAt: Date };

/**
 * The challenge a cookie holds, when the server sealed it for this purpose and this player and it has
 * not run out; null for anything else (another purpose, another player, a changed or old value).
 */
export function openChallenge(value: string | null | undefined, purpose: CeremonyPurpose, playerId: string | null, now = new Date()): OpenedChallenge | null {
  if (typeof value !== "string" || value.length > 400) return null;
  const parts = value.split(".");
  if (parts.length !== 6 || parts[0] !== "c1" || parts[1] !== purpose) return null;
  const [, , who, exp, challenge, sig] = parts;
  if (who !== (playerId ?? "-") || (who !== "-" && !PLAYER.test(who)) || !/^\d{1,16}$/.test(exp) || !B64URL.test(challenge)) return null;
  if (Number(exp) < now.getTime()) return null;
  const expected = hmac(`passkey-challenge:${purpose}:${who}:${exp}:${challenge}`);
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { challenge, expiresAt: new Date(Number(exp)) };
}

/**
 * Spends a challenge once: true the first time, false for every use after it. A rate row keyed by a
 * hash of the challenge with a limit of one (`takeRate`), so no table and nothing to clean but what the
 * hourly prune already takes (`pruneRateRows`, two days on).
 *
 * The row's day is the day of the seal's own expiry, never the day of the attempt. A rate row belongs to
 * one UTC day, and the cookie lives five minutes: with the attempt's day, a copy of the cookie and its
 * answer sent again just after 00:00 UTC met a fresh row and signed in a second time (review, 12 October
 * 2026). A synced passkey reports a counter of 0 every time, so the counter could not stop it either.
 */
export async function spendChallenge(db: Db, opened: OpenedChallenge): Promise<boolean> {
  const key = createHash("sha256").update(opened.challenge).digest("base64url").slice(0, 22);
  return takeRate(db, "passkey_once", key, 1, "day", opened.expiresAt);
}

/**
 * A failure of a passkey's query, fit for the log: its kind and the database's code, never its message.
 * A failed query's message carries the query's values ("params: …"), which here are a credential id or
 * a public key, and the error report logs, stores and alerts on the message.
 */
export function quietPasskeyError(e: unknown): Error {
  const cause = typeof e === "object" && e !== null ? (e as { cause?: { code?: unknown } }).cause : undefined;
  const code = typeof cause?.code === "string" && /^[0-9A-Z]{5}$/.test(cause.code) ? ` ${cause.code}` : "";
  const kind = e instanceof Error && /^[A-Z][A-Za-z]{0,40}$/.test(e.constructor.name) ? e.constructor.name : "unknown";
  return new Error(`passkey step failed: ${kind}${code}`);
}

/** The challenge cookie's options: httpOnly, secure in production, sameSite lax, five minutes. */
export const challengeCookie = () => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: CHALLENGE_TTL_MS / 1000 });

/**
 * What the browser hands `navigator.credentials.create`: a passkey that lives on the phone (a resident
 * key), Face ID or a fingerprint required, no attestation, the phone's name for it the player's own
 * name ("Ana"), and the passkeys the player already has excluded, so a phone that remembers them says
 * so instead of saving a second one.
 */
export async function registrationOptions(player: { id: string; displayName: string }, existing: readonly Pick<Passkey, "id" | "transports">[]): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpID } = relyingParty();
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: player.displayName,
    userDisplayName: player.displayName,
    userID: passkeyUserId(player.id),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    timeout: CHALLENGE_TTL_MS,
  });
}

/** What the browser hands `navigator.credentials.get`: no list of passkeys (the phone offers its own), Face ID or a fingerprint required. */
export async function authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpID } = relyingParty();
  return generateAuthenticationOptions({ rpID, userVerification: "required", timeout: CHALLENGE_TTL_MS });
}

/** The ways a phone says it can be reached (WebAuthn's transports: internal, hybrid, usb, nfc, ble, smart-card, cable): lower-case words only. */
const TRANSPORT = /^[a-z-]{2,20}$/;

/** A passkey the phone made, as the row keeps it. */
export type NewPasskey = { id: string; publicKey: string; counter: number; transports: string[]; deviceType: string; backedUp: boolean };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The shape a ceremony's answer must have before the library reads it: an object with a base64url id, the same as its raw id. */
const shaped = (v: unknown): boolean => isObject(v) && typeof v.id === "string" && CREDENTIAL.test(v.id) && v.rawId === v.id && isObject(v.response) && v.type === "public-key";

/**
 * The phone's answer to a save, checked against the challenge, this app's origin and host, with Face
 * ID or a fingerprint required. Null for anything that does not check out; the reason is never logged.
 * The id kept is the one inside the signed authenticator data, so it must be the answer's own id and
 * have the shape of one: the library compares the answer's `id` with its `rawId` only, and a crafted
 * save with another id, or one of 3000 bytes, inside the data otherwise reached the insert and failed
 * there, as a server error with the key in its message (review, 12 October 2026).
 *
 * A page's own challenge ("passkey-page", src/lib/passkeys/page.ts) signs in and never saves: a save
 * signed over one is refused whatever challenge the caller expected, so a page's challenge can never
 * become a way to put a passkey on a record.
 */
export async function verifyRegistration(response: unknown, challenge: string): Promise<NewPasskey | null> {
  if (!shaped(response)) return null;
  const { rpID, origin } = relyingParty();
  try {
    const r = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: (signed: string) => signed === challenge && !isPageSeal(signed),
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!r.verified) return null;
    const { credential, credentialDeviceType, credentialBackedUp } = r.registrationInfo;
    if (credential.id !== (response as RegistrationResponseJSON).id || !CREDENTIAL.test(credential.id)) return null;
    const transports = ((response as RegistrationResponseJSON).response.transports ?? credential.transports ?? []).filter((t): t is string => typeof t === "string" && TRANSPORT.test(t)).slice(0, 8);
    return { id: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64url"), counter: credential.counter, transports, deviceType: credentialDeviceType, backedUp: credentialBackedUp };
  } catch {
    return null;
  }
}

/** The credential id a sign-in answer names, when it has the shape of one: the one lookup the sign-in makes. */
export const answerCredentialId = (response: unknown): string | null => (shaped(response) ? String((response as { id: string }).id) : null);

/**
 * The phone's answer to a sign-in, checked against the challenge, this app's origin and host, the
 * stored public key and counter, with Face ID or a fingerprint required. The new counter, or null.
 * `challenge` is the options call's challenge itself, or, for a page's own challenge, the check of its
 * seal, its purpose and its expiry, which the library runs on the challenge the phone signed.
 */
export async function verifyAssertion(response: unknown, challenge: string | ((signed: string) => boolean), passkey: Pick<Passkey, "id" | "publicKey" | "counter" | "transports">): Promise<{ newCounter: number } | null> {
  if (!shaped(response) || (response as { id: string }).id !== passkey.id) return null;
  const { rpID, origin } = relyingParty();
  try {
    const r = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: passkey.id, publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")), counter: Number(passkey.counter), transports: passkey.transports },
      requireUserVerification: true,
    });
    return r.verified ? { newCounter: r.authenticationInfo.newCounter } : null;
  } catch {
    return null;
  }
}
