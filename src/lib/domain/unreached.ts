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
 * The first names of the candidates the offer would want and cannot reach, in the candidates' order:
 * the match's level range admits them (`admits`) and no channel reaches them on this deployment
 * (`channelOf`). Pure.
 */
export function unreachedNames(rows: readonly PartnerRow[], here: UnreachedHere, reach: RefillReach, range: Pick<Event, "levelMin" | "levelMax">): string[] {
  const devices = new Set(rows.filter((r) => r.push).map((r) => r.id));
  return unreachedCandidates(rows, here)
    .filter((r) => admits(range, r) && channelOf(r, reach, devices) === null)
    .map((r) => firstName(r.name));
}

/** The line's names: at most `UNREACHED_SHOWN`, and how many more. Pure. */
export function unreachedLine(names: readonly string[]): { shown: string[]; more: number } {
  return { shown: names.slice(0, UNREACHED_SHOWN), more: Math.max(0, names.length - UNREACHED_SHOWN) };
}

/**
 * The names for the organiser's line: the offer's past partners of this match in one read (the offer's
 * own query as a subquery, joined to the players' key, push as an `exists` down
 * `push_subscriptions_player_idx`), then the rules above. A match's organiser never names themself. A
 * tournament has no partners, and reads nothing.
 */
export async function unreachedPartners(
  db: Db,
  ev: Pick<Event, "id" | "type" | "capacity" | "creatorPlayerId" | "levelMin" | "levelMax">,
  here: UnreachedHere,
  reach: RefillReach,
  now: Date,
): Promise<string[]> {
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
  return unreachedNames(
    rows.map((r) => ({ ...r, push: Boolean(r.push) })),
    { ...here, ids: new Set([...here.ids, ev.creatorPlayerId]) },
    reach,
    ev,
  );
}
