import "server-only";
import { cache } from "react";
import { hintCookieOptions } from "@/lib/hintCookie";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { Db } from "@/db";
import { getPlayer } from "@/lib/domain/players";
import { sessionSecret } from "@/lib/env";
import type { Player } from "@/db/schema";
import { predatesSignOut, renewDue, renewedOnOf, utcDay } from "@/lib/domain/browserSession";
import { isValidShareCode } from "@/lib/codes";

export const PLAYER_COOKIE = "km_player";
/** Non-httpOnly companion so client code can tell "no identity" from "stale render". */
export const HAS_ID_COOKIE = "km_has_id";
/** How long the identity and manage cookies last. /privacy says it in words; tests/legal.test.ts holds the two together. */
export const ONE_YEAR = 60 * 60 * 24 * 365;
/**
 * The moment this browser last signed out ("Not you? Sign out", the owner, 28 October 2026), in
 * milliseconds, base 36. Every credential the browser held from before it opens nothing
 * (`predatesSignOut`): the restore seal in its storage and a match's manage cookie, which the sign-out
 * cannot delete unless the browser sends it, because each lives on its match's own path. A credential the
 * server gives after the sign-out carries the moment and works. httpOnly, so no script on the page can
 * take it away; a browser that clears its cookies loses it with everything it refused.
 */
export const SIGNED_OUT_COOKIE = "km_signed_out";

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
 *
 * Since 28 October 2026 a seal can carry two more figures, and then reads `r2.<id>.<p|n>.<out>.<until>.<signature>`:
 * `out`, the browser's last sign-out when the seal was made (`SIGNED_OUT_COOKIE`; a seal from before a
 * later sign-out opens nothing), and `until`, the end of a sign-in by name (a year after it began; the
 * restore gives back only what is left of that year). Both in milliseconds, base 36, 0 for none. A seal
 * with neither stays `r1`, so a browser that never signed out and is not signed in by name keeps the
 * seal it has.
 */
export function restoreSeal(playerId: string, byName: boolean, o: { out?: number; until?: number } = {}): string {
  const kind = byName ? "n" : "p";
  const out = Math.max(0, Math.floor(o.out ?? 0));
  const until = byName ? Math.max(0, Math.floor(o.until ?? 0)) : 0;
  if (!out && !until) return `r1.${playerId}.${kind}.${sign(`restore:${kind}:${playerId}`)}`;
  const tail = `${out.toString(36)}.${until.toString(36)}`;
  return `r2.${playerId}.${kind}.${tail}.${sign(`restore2:${kind}:${playerId}:${tail}`)}`;
}

const BASE36 = /^[0-9a-z]{1,12}$/;

/** The player, the kind of session, and the two figures (0 for none) a restore seal gives back; null for a raw id, a changed seal or anything else. */
export function openRestoreSeal(value: unknown): { playerId: string; byName: boolean; out: number; until: number } | null {
  if (typeof value !== "string" || value.length > 200) return null;
  const parts = value.split(".");
  if ((parts[0] === "r1" && parts.length !== 4) || (parts[0] === "r2" && parts.length !== 6) || (parts[0] !== "r1" && parts[0] !== "r2")) return null;
  if (!PLAYER_ID.test(parts[1]) || (parts[2] !== "p" && parts[2] !== "n")) return null;
  const byName = parts[2] === "n";
  if (parts[0] === "r1") return signs(parts[3], `restore:${parts[2]}:${parts[1]}`) ? { playerId: parts[1], byName, out: 0, until: 0 } : null;
  const [, id, kind, out36, until36, sig] = parts;
  if (!BASE36.test(out36) || !BASE36.test(until36) || !signs(sig, `restore2:${kind}:${id}:${out36}.${until36}`)) return null;
  return { playerId: id, byName, out: parseInt(out36, 36), until: byName ? parseInt(until36, 36) : 0 };
}

/** The restore seal for the browser signed in now as `playerId`: by name exactly when its session is by name, with its last sign-out and, by name, its end. */
export async function restoreSealForSession(playerId: string): Promise<string> {
  const byName = await signedInByName(playerId);
  return restoreSeal(playerId, byName, { out: await signedOutAt(), until: byName ? await byNameUntil(playerId) : 0 });
}

/** When this browser last signed out, in milliseconds; 0 when it never did, or the cookie says nothing a sign-out writes. */
export async function signedOutAt(): Promise<number> {
  const v = (await cookies()).get(SIGNED_OUT_COOKIE)?.value;
  return v && BASE36.test(v) ? parseInt(v, 36) : 0;
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
 * `km_has_id` carries the day the session's year began, which is all the renewal needs (`renewSession`).
 * A sign-in never clears the sign-out mark: what the browser held before it signed out stays shut.
 */
export async function setSessionPlayer(playerId: string): Promise<void> {
  const store = await cookies();
  store.set(PLAYER_COOKIE, sealPlayerId(playerId), sessionCookie());
  store.set(HAS_ID_COOKIE, utcDay(new Date()), hintCookieOptions());
  store.delete(BY_NAME_COOKIE);
}

const sessionCookie = (maxAge = ONE_YEAR) => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge });

export async function clearSessionPlayer(): Promise<void> {
  const store = await cookies();
  store.delete(PLAYER_COOKIE);
  store.delete(HAS_ID_COOKIE);
  store.delete(BY_NAME_COOKIE);
}

/**
 * "Not you? Sign out" (the owner, 28 October 2026): the session cookie, its companion and the by-name
 * mark go, so does every manage cookie this request carries (each lives on its match's own path, so the
 * browser sends one only from that match's page), and the browser is stamped with the moment, so the
 * restore seal it kept and every other manage cookie it holds open nothing from now on (`predatesSignOut`).
 * The page's script removes the seal and the passkey card's "Not now" from its storage too (`forgetBrowser`).
 */
export async function signOutBrowser(now = new Date()): Promise<void> {
  const store = await cookies();
  for (const c of store.getAll()) {
    const code = c.name.startsWith(MANAGE_PREFIX) ? c.name.slice(MANAGE_PREFIX.length) : null;
    if (code && isValidShareCode(code)) store.set(c.name, "", { ...sessionCookie(0), path: `/${code}` });
  }
  await clearSessionPlayer();
  store.set(SIGNED_OUT_COOKIE, now.getTime().toString(36), sessionCookie());
}

/**
 * A full sign-in lives a year after the last visit (the owner, 28 October 2026): at most once in 30 days
 * (`renewDue`, from the day `km_has_id` carries), the session cookie and its companion get a new year,
 * with the same value. Never a session by name, whose year counts from its start. No read: the cookies
 * alone say who and when. Called from `POST /api/me/session`, the one place a page's visit may set a
 * cookie, and only when the root layout saw it due. True when it renewed.
 */
export async function renewSession(now = new Date()): Promise<boolean> {
  const store = await cookies();
  const value = store.get(PLAYER_COOKIE)?.value;
  const session = openSession(value);
  const byName = session ? await signedInByName(session.id) : false;
  if (!renewDue({ signedIn: Boolean(session), byName, renewedOn: renewedOnOf(store.get(HAS_ID_COOKIE)?.value), today: utcDay(now) })) return false;
  store.set(PLAYER_COOKIE, value!, sessionCookie());
  store.set(HAS_ID_COOKIE, utcDay(now), hintCookieOptions());
  return true;
}

/** For the root layout: whether this browser's full sign-in is due its new year. Cookie reads only. */
export async function sessionRenewDue(now = new Date()): Promise<boolean> {
  const store = await cookies();
  const session = openSession(store.get(PLAYER_COOKIE)?.value);
  if (!session) return false;
  return renewDue({ signedIn: true, byName: await signedInByName(session.id), renewedOn: renewedOnOf(store.get(HAS_ID_COOKIE)?.value), today: utcDay(now) });
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
const ONE_YEAR_MS = ONE_YEAR * 1000;

/**
 * After `setSessionPlayer`: seals the session as one by name, and sets the mark cookie beside it. Since
 * 28 October 2026 the mark carries the end of the sign-in, a year after it began, signed for this
 * record (`<until>.<signature>`), and every cookie of the session ends then: a sign-in by name is never
 * renewed, and the restore seal that brings it back after a lost cookie carries the same end (`until`).
 */
export async function markSignedInByName(playerId: string, o: { until?: number; now?: Date } = {}): Promise<void> {
  const now = (o.now ?? new Date()).getTime();
  const until = o.until && o.until > now ? o.until : now + ONE_YEAR_MS;
  const left = Math.max(1, Math.floor((until - now) / 1000));
  const store = await cookies();
  const u = until.toString(36);
  store.set(PLAYER_COOKIE, sealPlayerId(playerId, { byName: true }), sessionCookie(left));
  store.set(BY_NAME_COOKIE, `${u}.${sign(`byname:${playerId}:${u}`)}`, sessionCookie(left));
  store.set(HAS_ID_COOKIE, utcDay(new Date(now)), { ...hintCookieOptions(), maxAge: left });
}

/** The end of this browser's sign-in by name as `playerId`, in milliseconds, from the mark; 0 when the mark carries none (one from before 28 October 2026, or none at all). */
export async function byNameUntil(playerId: string): Promise<number> {
  const v = (await cookies()).get(BY_NAME_COOKIE)?.value ?? "";
  const [u, sig] = v.split(".");
  return sig && BASE36.test(u) && signs(sig, `byname:${playerId}:${u}`) ? parseInt(u, 36) : 0;
}

/** Whether this browser's session came in by name, for this record: the session cookie says so, or (for a session from before 11 October 2026) the mark beside it. */
export async function signedInByName(playerId: string): Promise<boolean> {
  const store = await cookies();
  const session = openSession(store.get(PLAYER_COOKIE)?.value);
  if (session?.id === playerId && session.byName) return true;
  const v = store.get(BY_NAME_COOKIE)?.value;
  if (!v) return false;
  if (signs(v, `byname:${playerId}`)) return true;
  const [u, sig] = v.split(".");
  return Boolean(sig) && BASE36.test(u) && signs(sig, `byname:${playerId}:${u}`);
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
const MANAGE_PREFIX = "km_manage_";
export const manageCookieName = (code: string) => `${MANAGE_PREFIX}${code}`;

/**
 * The manage cookie: `<signature>`, or, in a browser that signed out before, `<sign-out>.<signature>`
 * with the moment of that sign-out inside the signed value, so a later sign-out shuts it (`predatesSignOut`).
 */
export async function grantManageAccess(code: string, manageCode: string): Promise<void> {
  const store = await cookies();
  const out = await signedOutAt();
  const value = out ? `${out.toString(36)}.${sign(`${code}:${manageCode}:${out.toString(36)}`)}` : sign(`${code}:${manageCode}`);
  store.set(manageCookieName(code), value, { ...sessionCookie(), path: `/${code}` });
}

export async function hasManageAccess(code: string, manageCode: string): Promise<boolean> {
  const store = await cookies();
  const v = store.get(manageCookieName(code))?.value;
  if (!v) return false;
  const parts = v.split(".");
  const [first, second] = parts;
  const minted =
    parts.length === 1 ? (signs(first, `${code}:${manageCode}`) ? 0 : -1) : parts.length === 2 && BASE36.test(first) && signs(second, `${code}:${manageCode}:${first}`) ? parseInt(first, 36) : -1;
  return minted >= 0 && !predatesSignOut(minted, await signedOutAt());
}
