import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { players, pushSubscriptions, type Event, type Player } from "@/db/schema";
import { normalName } from "./dupes";
import { admits, channelOf, partnersQuery, type RefillReach } from "./refill";
import { DELETED_PLAYER_NAME } from "./result";

/**
 * "Kicksmash can't reach Tim and Adrian. Send them the link." The owner's decision of 15 October 2026
 * (D1, DECIDING rule 7). The question was: "May the organiser's match page name the past partners that
 * Kicksmash cannot reach (no email, Telegram or push), so the organiser sends them the link?" The answer
 * was "Name them (Recommended)": "Only the organiser sees it, only while a place is open, only partners
 * from the last 60 days. Pro: you know whom to message (Tim, Adrian). Con: it shows that a named person
 * gave Kicksmash no contact."
 *
 * Why: on 15 October 13 of 16 past matches never filled, and the fourth seat is where they are lost.
 * The free-seat offer (`notifyRefill`, `refillAudience`) reaches only a past partner that a channel
 * reaches, 7 records of 21. For TDsv it reached Micky and Nicolai, not Tim or Adrian, who both played
 * with Erik. The organiser can message them; Kicksmash cannot.
 *
 *   - Who: the offer's own past partners (`partnersQuery` in `refill.ts`, the query `pastPartners`
 *     runs), narrowed to the organiser's own (`of`): the people the organiser, seated in this match,
 *     played with in a match (an americano makes
 *     no partners) that ended in the last 60 days, both seated in it. Then the offer's own exclusions:
 *     no row in this match, not its organiser, not gone from it (a leave or a removal, from the
 *     activity the page read). Then the rules of a name: not a deleted account, no name of the line-up,
 *     the one record of its name among those partners (as `pickable`), and the one candidate of its
 *     first name, because the line shows first names and "Tim and Tim" is nobody the organiser can
 *     tell apart. Last, the offer's own two tests (`admits` and `channelOf`): the match's level range
 *     admits them, and no channel reaches them on this deployment. A passkey is not a channel.
 *   - When: the organiser's own view of a match (a manage link is the organiser's view), not called
 *     off, not started, with a seat open (`unreachedDue`). Never anybody else, never public data, the
 *     API, a card, a picture or a notice.
 *   - Cost: one read, only for that view (rule 12): the offer's partner query as a subquery (bounded
 *     at its own 100, down its indexes), joined to the players' key, with push as an `exists` down
 *     `push_subscriptions_player_idx`.
 *   - Words: first names only (rule 7), at most `UNREACHED_SHOWN`, then "and 3 more" (`unreachedLine`).
 */

/** How many names the line shows before "and 3 more". */
export const UNREACHED_SHOWN = 5;

/** Whether the line may stand for this viewer: the organiser's own view (a manage link is one), of a match, not called off, not over, not started, with a seat open. Pure. */
export function unreachedDue(ev: Pick<Event, "type" | "status" | "startsAt">, openSeats: number, now: Date, organiser: boolean): boolean {
  if (!organiser) return false;
  if (ev.type !== "match") return false;
  if (ev.status === "cancelled" || ev.status === "past") return false;
  if (now.getTime() >= ev.startsAt.getTime()) return false;
  return openSeats > 0;
}

/** Whom the line leaves out because they are in the match or just left it. */
export type UnreachedHere = { ids: ReadonlySet<string>; names: readonly (string | null | undefined)[]; gone: ReadonlySet<string> };

/** A past partner as the one read gives it: the name, what the offer decides on, and whether a device of theirs takes push. */
export type PartnerRow = Pick<Player, "id" | "level" | "telegramId" | "phone" | "email" | "emailNotifications"> & { name: string; push: boolean };

/** The first name, as every public place writes a person (rule 7). */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? "";

/**
 * The past partners the line may name, in the order given (the freshest partner first): no row in this
 * match, not gone from it, not a deleted account, no name of the line-up, the only record of that name
 * among the partners, and the only candidate of that first name. Pure.
 */
export function unreachedCandidates<R extends Pick<PartnerRow, "id" | "name">>(rows: readonly R[], here: UnreachedHere): R[] {
  const count = new Map<string, number>();
  for (const r of rows) count.set(normalName(r.name), (count.get(normalName(r.name)) ?? 0) + 1);
  const taken = new Set(here.names.map((n) => normalName(n)).filter(Boolean));
  const named = rows.filter((r) => firstName(r.name) && r.name !== DELETED_PLAYER_NAME && count.get(normalName(r.name)) === 1 && !here.ids.has(r.id) && !here.gone.has(r.id) && !taken.has(normalName(r.name)));
  const firsts = new Map<string, number>();
  for (const r of named) firsts.set(normalName(firstName(r.name)), (firsts.get(normalName(firstName(r.name))) ?? 0) + 1);
  return named.filter((r) => firsts.get(normalName(firstName(r.name))) === 1);
}

/**
 * The candidates the offer would want and cannot reach, in the candidates' order: the match's level
 * range admits them (`admits`) and no channel reaches them on this deployment (`channelOf`). Pure.
 */
export function unreachedRows<R extends PartnerRow>(rows: readonly R[], here: UnreachedHere, reach: RefillReach, range: Pick<Event, "levelMin" | "levelMax">): R[] {
  const devices = new Set(rows.filter((r) => r.push).map((r) => r.id));
  return unreachedCandidates(rows, here).filter((r) => admits(range, r) && channelOf(r, reach, devices) === null);
}

/** Their first names, as the organiser's line shows them. Pure. */
export function unreachedNames(rows: readonly PartnerRow[], here: UnreachedHere, reach: RefillReach, range: Pick<Event, "levelMin" | "levelMax">): string[] {
  return unreachedRows(rows, here, reach, range).map((r) => firstName(r.name));
}

/** The line's names: at most `UNREACHED_SHOWN`, and how many more. Pure. */
export function unreachedLine(names: readonly string[]): { shown: string[]; more: number } {
  return { shown: names.slice(0, UNREACHED_SHOWN), more: Math.max(0, names.length - UNREACHED_SHOWN) };
}

/** The match as the line reads it. */
type UnreachedMatch = Pick<Event, "id" | "type" | "capacity" | "creatorPlayerId" | "levelMin" | "levelMax">;

/**
 * The names for the organiser's line: the offer's past partners of this match in one read (the offer's
 * own query as a subquery, joined to the players' key, push as an `exists` down
 * `push_subscriptions_player_idx`), then the rules above. A match's organiser never names themself. A
 * tournament has no partners, and reads nothing.
 */
export async function unreachedPartners(db: Db, ev: UnreachedMatch, here: UnreachedHere, reach: RefillReach, now: Date): Promise<string[]> {
  return (await unreachedRecords(db, ev, here, reach, now)).map((r) => firstName(r.name));
}

/** The same read as `unreachedPartners`, each partner with its record, for the server's own use (`unreachedNamed`): never sent to a browser. */
export async function unreachedRecords(db: Db, ev: UnreachedMatch, here: UnreachedHere, reach: RefillReach, now: Date): Promise<{ id: string; name: string }[]> {
  if (ev.type !== "match") return [];
  const partners = partnersQuery(db, ev, now, { of: ev.creatorPlayerId }).as("partners");
  const rows = await db
    .select({
      id: players.id,
      name: players.displayName,
      level: players.level,
      telegramId: players.telegramId,
      phone: players.phone,
      email: players.email,
      emailNotifications: players.emailNotifications,
      push: sql<boolean>`exists (select 1 from ${pushSubscriptions} ps where ps.player_id = ${players.id})`,
    })
    .from(partners)
    .innerJoin(players, eq(players.id, partners.playerId))
    .orderBy(desc(partners.last), players.id);
  return unreachedRows(
    rows.map((r) => ({ ...r, push: Boolean(r.push) })),
    { ...here, ids: new Set([...here.ids, ev.creatorPlayerId]) },
    reach,
    ev,
  ).map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Whom the line leaves out, from the rows a match page or an action already read: every record with a
 * row in the match, every name on it (a held place's too), and whoever left it or was taken out (the
 * activity). The page and `unreachedNamed` both ask this, so they name the same partners. Pure.
 */
export function unreachedHereOf(detail: {
  roster: readonly { status: string; playerId: string | null; invitedName: string | null; player: { displayName: string } | null }[];
  waitlist: readonly { status: string; playerId: string | null; invitedName: string | null; player: { displayName: string } | null }[];
  activity: readonly { verb: string; actorPlayerId: string | null; meta: unknown }[];
}): UnreachedHere {
  const all = [...detail.roster, ...detail.waitlist];
  const targetOf = (meta: unknown) => (meta && typeof meta === "object" && typeof (meta as { targetPlayerId?: unknown }).targetPlayerId === "string" ? [(meta as { targetPlayerId: string }).targetPlayerId] : []);
  return {
    ids: new Set(all.flatMap((s) => (s.playerId ? [s.playerId] : []))),
    names: all.filter((s) => s.status !== "empty" && s.status !== "declined").map((s) => s.player?.displayName ?? s.invitedName ?? "").filter(Boolean),
    gone: new Set(detail.activity.flatMap((a) => (a.verb === "left" && a.actorPlayerId ? [a.actorPlayerId] : a.verb === "removed" ? targetOf(a.meta) : []))),
  };
}

/**
 * "That's me" for a name on the organiser's unreached list (the owner's decision of 16 October 2026, D6,
 * DECIDING rule 34). The question was: "Tim has no email or Telegram. When you send him the plain link
 * from "Kicksmash can't reach Tim", he types "Tim" and Kicksmash makes a second Tim. What should the line
 * offer?" The owner chose "Let That's me sign him in": ""That's me" accepts a name from your unreached
 * list on the plain link. Pro: no place held. Con: widens sign-in by name beyond your rule 34." (The
 * owner chose this over the recommended "Hold a place for Tim".)
 *
 * When: a match, not called off, not over, not started (`unreachedSignInDue`): the time the organiser
 * sends the link. Not only while a seat is open: Tim may open the link once the match is full and want
 * the waiting list.
 */
export function unreachedSignInDue(ev: Pick<Event, "type" | "status" | "startsAt">, now: Date): boolean {
  if (ev.type !== "match") return false;
  if (ev.status === "cancelled" || ev.status === "past") return false;
  return now.getTime() < ev.startsAt.getTime();
}

/**
 * The record of the organiser's unreached list that a typed name names, or null: the same list the
 * organiser's line shows (`unreachedRecords`, one bounded read), the typed name against each partner's
 * first name or whole name by the held-name rule's normalisation (`normalName`). The list gives one
 * partner of each first name, so a first name finds one record at most. The server keeps the answer:
 * the browser gets only the offer for the name it typed, never the list or an id.
 */
export async function unreachedNamed(
  db: Db,
  detail: { event: UnreachedMatch & Pick<Event, "status" | "startsAt">; roster: Parameters<typeof unreachedHereOf>[0]["roster"]; waitlist: Parameters<typeof unreachedHereOf>[0]["waitlist"]; activity: Parameters<typeof unreachedHereOf>[0]["activity"] },
  typed: string | null | undefined,
  reach: RefillReach,
  now: Date,
): Promise<{ id: string; name: string } | null> {
  const key = normalName(typed);
  if (key.length < 2 || !unreachedSignInDue(detail.event, now)) return null;
  const rows = await unreachedRecords(db, detail.event, unreachedHereOf(detail), reach, now);
  return rows.find((r) => normalName(firstName(r.name)) === key || normalName(r.name) === key) ?? null;
}
