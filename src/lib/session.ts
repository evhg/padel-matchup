import "server-only";
import { cache } from "react";
import { hintCookieOptions } from "@/lib/hintCookie";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { Db } from "@/db";
import { getPlayer } from "@/lib/domain/players";
import { sessionSecret } from "@/lib/env";
import type { Player } from "@/db/schema";

export const PLAYER_COOKIE = "km_player";
/** Non-httpOnly companion so client code can tell "no identity" from "stale render". */
export const HAS_ID_COOKIE = "km_has_id";
/** How long the identity and manage cookies last. /privacy says it in words; tests/legal.test.ts holds the two together. */
export const ONE_YEAR = 60 * 60 * 24 * 365;

const secret = sessionSecret;

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

/** Whether `sig` is the signature of `value`, compared in constant time. */
function signs(sig: string, value: string): boolean {
  const expected = sign(value);
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

const PLAYER_ID = /^[0-9a-f-]{36}$/i;

/**
 * The session cookie's value: `<id>.<signature>` for a sign-in that proved who it is, and
 * `<id>.n.<signature>` for a sign-in by name ("That's me", DECIDING rule 34). The mark is inside the
 * signed value, so a browser cannot drop it to become a full session: until 11 October 2026 it lived
 * only in a cookie of its own (`km_by_name`), which the browser could simply delete.
 */
export function sealPlayerId(playerId: string, o: { byName?: boolean } = {}): string {
  return o.byName ? `${playerId}.n.${sign(`byname-session:${playerId}`)}` : `${playerId}.${sign(playerId)}`;
}

/** The session a cookie value holds: the player and whether they came in by name. Null for anything the server did not seal. */
function openSession(token: string | undefined | null): { id: string; byName: boolean } | null {
  if (typeof token !== "string" || !token) return null;
  const parts = token.split(".");
  if (parts.length === 2 && PLAYER_ID.test(parts[0]) && signs(parts[1], parts[0])) return { id: parts[0], byName: false };
  if (parts.length === 3 && parts[1] === "n" && PLAYER_ID.test(parts[0]) && signs(parts[2], `byname-session:${parts[0]}`)) return { id: parts[0], byName: true };
  return null;
}

export function unsealPlayerId(token: string | undefined | null): string | null {
  return openSession(token)?.id ?? null;
}

/**
 * What a browser keeps in localStorage to come back after a lost cookie (`IdentitySync`), and the only
 * thing `restoreIdentity` takes: `r1.<id>.<p|n>.<signature>`, signed for this purpose and for the kind
 * of session it gives back (`p` proved, `n` by name). Until 11 October 2026 the browser kept the raw
 * player id and the restore took any id it was given, while the match page sent every seated player's
 * id to every viewer: anybody could become anybody. A raw id is no proof of anything, and a seal for
 * another purpose (the session cookie, the by-name mark) opens nothing here.
 */
export function restoreSeal(playerId: string, byName: boolean): string {
  const kind = byName ? "n" : "p";
  return `r1.${playerId}.${kind}.${sign(`restore:${kind}:${playerId}`)}`;
}

/** The player and the kind of session a restore seal gives back; null for a raw id, a changed seal or anything else. */
export function openRestoreSeal(value: unknown): { playerId: string; byName: boolean } | null {
  if (typeof value !== "string" || value.length > 200) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "r1" || !PLAYER_ID.test(parts[1]) || (parts[2] !== "p" && parts[2] !== "n")) return null;
  if (!signs(parts[3], `restore:${parts[2]}:${parts[1]}`)) return null;
  return { playerId: parts[1], byName: parts[2] === "n" };
}

/** The restore seal for the browser signed in now as `playerId`: by name exactly when its session is by name. */
export async function restoreSealForSession(playerId: string): Promise<string> {
  return restoreSeal(playerId, await signedInByName(playerId));
}

export async function getSessionPlayerId(): Promise<string | null> {
  const store = await cookies();
  return unsealPlayerId(store.get(PLAYER_COOKIE)?.value);
}

/**
 * One read of the session's player for each server render: the root layout (the restore seal) and the
 * page (the viewer) asked for the same row, so a signed-in match page read it twice. React's `cache`
 * keeps an answer only inside the render of one request. A server action and a route handler run
 * outside a render, so each of their calls reads the row afresh, and the page that an action renders
 * again after a write is a new render with a new read.
 */
const playerOnce = cache((db: Db, id: string) => getPlayer(db, id));

export async function getSessionPlayer(db: Db): Promise<Player | null> {
  const id = await getSessionPlayerId();
  if (!id) return null;
  return playerOnce(db, id);
}

/**
 * Every sign-in sets the cookie here, and every one of them ends a mark of a sign-in by name: the
 * browser is now whoever this door says it is. `thatsMeAction` sets the mark again after it.
 */
export async function setSessionPlayer(playerId: string): Promise<void> {
  const store = await cookies();
  store.set(PLAYER_COOKIE, sealPlayerId(playerId), sessionCookie());
  store.set(HAS_ID_COOKIE, "1", hintCookieOptions());
  store.delete(BY_NAME_COOKIE);
}

const sessionCookie = () => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: ONE_YEAR });

export async function clearSessionPlayer(): Promise<void> {
  const store = await cookies();
  store.delete(PLAYER_COOKIE);
  store.delete(HAS_ID_COOKIE);
  store.delete(BY_NAME_COOKIE);
}

/**
 * A session that came in by "That's me" (DECIDING rule 34). The mark is in the session cookie itself
 * (`sealPlayerId` with `byName`), signed for that one record, so it cannot be copied onto another, cannot
 * be dropped, and says nothing once the browser signs in as anybody else. The cookie of its own beside
 * it is the mark as it was set before 11 October 2026, still read for the sessions made then. What the
 * mark holds back, and until when, is `nameOnlySession` (src/lib/domain/thatsMe.ts): no personal link
 * and no home-screen card until the record proves something.
 */
export const BY_NAME_COOKIE = "km_by_name";
const byNameValue = (playerId: string) => sign(`byname:${playerId}`);

/** After `setSessionPlayer`: seals the session as one by name, and sets the mark cookie beside it. */
export async function markSignedInByName(playerId: string): Promise<void> {
  const store = await cookies();
  store.set(PLAYER_COOKIE, sealPlayerId(playerId, { byName: true }), sessionCookie());
  store.set(BY_NAME_COOKIE, byNameValue(playerId), sessionCookie());
}

/** Whether this browser's session came in by name, for this record: the session cookie says so, or (for a session from before 11 October 2026) the mark beside it. */
export async function signedInByName(playerId: string): Promise<boolean> {
  const store = await cookies();
  const session = openSession(store.get(PLAYER_COOKIE)?.value);
  if (session?.id === playerId && session.byName) return true;
  const v = store.get(BY_NAME_COOKIE)?.value;
  return Boolean(v) && signs(v!, `byname:${playerId}`);
}

/**
 * An opaque name for one member of one crew, for the admin's buttons (remove, hand over). The crew page
 * goes to everybody with its link, so it never carries a player id; the action reads the crew's members
 * and finds the one whose handle it was given (`memberByHandle` in src/actions/groups.ts).
 */
export const memberHandle = (groupId: string, playerId: string): string => sign(`member:${groupId}:${playerId}`).slice(0, 22);

/**
 * An opaque name for one of a player's own passkeys, for "Remove" on My matches: the page never carries
 * the credential id (DECIDING rule 39), and the action finds the passkey among the player's own whose
 * handle it was given (`removePasskeyAction`), so a handle opens nothing of anybody else's.
 */
export const passkeyHandle = (playerId: string, credentialId: string): string => sign(`passkey:${playerId}:${credentialId}`).slice(0, 22);

/** Per-event organizer access granted by visiting /{code}/manage/{manageCode}. */
export const manageCookieName = (code: string) => `km_manage_${code}`;

export async function grantManageAccess(code: string, manageCode: string): Promise<void> {
  const store = await cookies();
  store.set(manageCookieName(code), sign(`${code}:${manageCode}`), { ...sessionCookie(), path: `/${code}` });
}

export async function hasManageAccess(code: string, manageCode: string): Promise<boolean> {
  const store = await cookies();
  const v = store.get(manageCookieName(code))?.value;
  return Boolean(v) && signs(v!, `${code}:${manageCode}`);
}
