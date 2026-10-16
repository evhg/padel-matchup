import "server-only";
import { getLocale } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { clientKeyFrom } from "@/lib/ipKey";
import { later, reportError } from "@/lib/alerts";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { getDb, type Db } from "@/db";
import type { Player } from "@/db/schema";
import { isDomainError, type DomainErrorCode } from "@/lib/domain/errors";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import { canEditMatchDetails } from "@/lib/domain/events";
import { createPlayer, normalizeName } from "@/lib/domain/players";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { countNewRecord } from "@/lib/domain/signins";
import { countedSource, SOURCE_COOKIE } from "@/lib/source";
import { getSessionPlayer, hasManageAccess, setSessionPlayer, signedInByName } from "@/lib/session";
import { nameOnlySession } from "@/lib/domain/thatsMe";
import { baseUrl } from "@/lib/config";
import { manageUrl } from "@/lib/share";

/**
 * `name_held`: the name has a held place this browser may take (DECIDING rule 34); a plain join would leave it behind for good.
 * `name_seated`: a record of the typed name holds a seat or a waiting place here, so the join asks "Sign in as Danny?" first (the owner, 15 October 2026).
 * `name_unreached`: the typed name is a past partner on the organiser's unreached list that "That's me" signs in, so the join asks first (the owner, 16 October 2026, D6).
 */
export type ActionError = DomainErrorCode | "generic" | "name_required" | "no_identity" | "email_disabled" | "too_many" | "level_required" | "name_held" | "name_seated" | "name_unreached";
export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: ActionError; detail?: string };

export async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (isDomainError(e)) return { ok: false, error: e.code, detail: e.message !== e.code ? e.message : undefined };
    await later(() => reportError("server", e));
    return { ok: false, error: "generic" };
  }
}

/** The caller's rate-limit key: a keyed hash of their address, never the address itself (`src/lib/ipKey.ts`). */
export async function clientKey(): Promise<string> {
  return clientKeyFrom(await headers());
}

/** Fixed-window rate limit; throws `too_many` past the ceiling. */
export async function assertRate(db: Db, scope: string, id: string, limit: number, window: "day" | "hour" = "day", by = 1): Promise<void> {
  if (!(await takeRate(db, scope, id, limit, window, new Date(), by))) throw new ActionFailure("too_many");
}

/** `detail`: words for the screen beside the code, never a secret (the doors of "Sign in as Danny?", `doorsDetail`). */
export class ActionFailure extends Error {
  constructor(
    public readonly code: ActionError,
    public readonly detail?: string,
  ) {
    super(code);
  }
}

export async function runA<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof ActionFailure) return e.detail === undefined ? { ok: false, error: e.code } : { ok: false, error: e.code, detail: e.detail };
    if (isDomainError(e)) return { ok: false, error: e.code, detail: e.message !== e.code ? e.message : undefined };
    await later(() => reportError("server", e));
    return { ok: false, error: "generic" };
  }
}

/**
 * Returns the current player, creating one from `name` when there is no identity yet. A record made
 * here counts its browser, the link it came through and, with `namesHere` (everybody already in the
 * match it joins), whether its name was already there (`countNewRecord`).
 */
export async function requirePlayer(db: Db, name?: string | null, o: { namesHere?: readonly (string | null | undefined)[] } = {}): Promise<Player> {
  const existing = await getSessionPlayer(db);
  if (existing) return existing;
  const clean = normalizeName(name ?? "");
  if (!clean) throw new ActionFailure("name_required");
  await assertRate(db, "newid", await clientKey(), LIMITS.newIdentitiesPerIpPerDay);
  const locale = await getLocale();
  const player = await createPlayer(db, { displayName: clean, locale });
  await setSessionPlayer(player.id);
  // Read now, counted after the answer: bookkeeping never sits in the path a person waits on (`later`).
  const [h, jar] = [await headers(), await cookies()];
  const seen = { ua: h.get("user-agent"), source: countedSource(jar.get(SOURCE_COOKIE)?.value), name: clean, namesHere: o.namesHere };
  await later(() => countNewRecord(db, seen));
  return player;
}

/**
 * A session that came in by "That's me" and has proved nothing since (DECIDING rule 34): My matches
 * shows it no personal link and no home-screen card, the manifest gives it no personal start page, and
 * the link can be neither rotated nor mailed from it.
 */
export async function nameOnly(player: Player | null): Promise<boolean> {
  return player ? nameOnlySession(await signedInByName(player.id), player) : false;
}

/**
 * The personal token for a screen or a file that hands the session's own personal link to its browser
 * (My matches, the home-screen card, the manifest, the match's .ics). Null for a session by name that
 * has proved nothing (`nameOnly`): the personal link is a full sign-in, so it would undo the hold-back.
 * Until 11 October 2026 the organiser's share page and the .ics download gave it to such a session:
 * "That's me", then a match of one's own or any match's calendar file, and the link was there.
 */
export async function personalTokenFor(db: Db, player: Player | null): Promise<string | null> {
  if (!player || (await nameOnly(player))) return null;
  return getOrCreatePersonalToken(db, player.id);
}

/**
 * The match's manage link for a screen that shows it to its organiser (the organiser's panel, the share
 * page). Null for a session by name that has proved nothing (`nameOnly`), unless this browser opened
 * the manage link itself (`hasManageAccess`): the link never expires and works in any browser, and
 * since the owner's decisions of 11 October 2026 "That's me" and a held place's link sign in a record
 * that organised past matches. On a finished match it keeps the organiser's powers (levels, scores)
 * after the real person proves themselves. Two cookie reads, no database read.
 */
export async function manageUrlFor(player: Player | null, ev: { code: string; manageCode: string }): Promise<string | null> {
  if ((await nameOnly(player)) && !(await hasManageAccess(ev.code, ev.manageCode))) return null;
  return manageUrl(baseUrl(), ev.code, ev.manageCode);
}

export type Viewer = { player: Player | null; isCreator: boolean };

export async function getViewer(db: Db, detail: EventDetail): Promise<Viewer> {
  const player = await getSessionPlayer(db);
  const isCreator = (player && player.id === detail.event.creatorPlayerId) || (await hasManageAccess(detail.event.code, detail.event.manageCode));
  return { player, isCreator: Boolean(isCreator) };
}

export async function loadEvent(code: string): Promise<{ db: Db; detail: EventDetail }> {
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail) throw new ActionFailure("not_found");
  return { db, detail };
}

export async function requireCreator(code: string): Promise<{ db: Db; detail: EventDetail; viewer: Viewer }> {
  const { db, detail } = await loadEvent(code);
  const viewer = await getViewer(db, detail);
  if (!viewer.isCreator) throw new ActionFailure("forbidden");
  return { db, detail, viewer };
}

/** The organiser, or a player with a seat in this match (`canEditMatchDetails`). */
export async function requireMatchEditor(code: string): Promise<{ db: Db; detail: EventDetail; viewer: Viewer }> {
  const { db, detail } = await loadEvent(code);
  const viewer = await getViewer(db, detail);
  if (!canEditMatchDetails(detail, { isCreator: viewer.isCreator, playerId: viewer.player?.id })) throw new ActionFailure("forbidden");
  return { db, detail, viewer };
}
