import { inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { players, pushSubscriptions, type Event, type Player } from "@/db/schema";
import { normalName } from "./dupes";
import type { PastPlayer } from "./heldRecord";
import { admits, channelOf, PARTNER_WINDOW_MS, type RefillReach } from "./refill";

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
 *   - Who: the organiser's past players (`pastPlayerRows`, the read the page makes for "Played with
 *     you" already), from a match in the last 60 days (`PARTNER_WINDOW_MS`, the offer's own window),
 *     not in this match by record or by name, not gone from it (a leave or a removal, from the
 *     activity the page read), one record of the name (as `pickable`), whose level the match admits
 *     and whom no channel reaches on this deployment: the offer's own two tests (`admits` and
 *     `channelOf` in `refill.ts`), so the line names exactly the partners the offer cannot reach. A
 *     passkey is not a channel.
 *   - When: the organiser's own view of a match (a manage link is the organiser's view), not called
 *     off, not started, with a seat open (`unreachedDue`). Never anybody else, never public data, the
 *     API, a card, a picture or a notice.
 *   - Cost: one read down the players' key, with an `exists` down `push_subscriptions_player_idx`,
 *     at most `UNREACHED_READ_MAX` records, only for that view (rule 12).
 *   - Words: first names only (rule 7), at most `UNREACHED_SHOWN`, then "and 3 more" (`unreachedLine`).
 */

/** How many names the line shows before "and 3 more". */
export const UNREACHED_SHOWN = 5;
/** How many candidates the one read takes, the latest first (rule 12). */
export const UNREACHED_READ_MAX = 100;

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

/**
 * The past partners the offer would want, latest first: a match together in the last 60 days, no row in
 * this match, no name of the line-up, not gone from it, and the only record of that name among the
 * organiser's past players (two Tims are nobody the organiser can tell apart). Pure.
 */
export function unreachedCandidates(list: readonly PastPlayer[], here: UnreachedHere, now: Date): PastPlayer[] {
  const since = now.getTime() - PARTNER_WINDOW_MS;
  const count = new Map<string, number>();
  for (const p of list) count.set(normalName(p.name), (count.get(normalName(p.name)) ?? 0) + 1);
  const taken = new Set(here.names.map((n) => normalName(n)).filter(Boolean));
  return list.filter((p) => p.last.getTime() >= since && count.get(normalName(p.name)) === 1 && !here.ids.has(p.id) && !here.gone.has(p.id) && !taken.has(normalName(p.name)));
}

/** What the offer reads about a person to decide, and whether a device of theirs takes push. */
export type ReachRow = Pick<Player, "id" | "level" | "telegramId" | "phone" | "email" | "emailNotifications"> & { push: boolean };

/** The first name, as every public place writes a person (rule 7). */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? "";

/**
 * The first names of the candidates the offer would want and cannot reach, in the candidates' order:
 * the match's level range admits them (`admits`) and no channel reaches them on this deployment
 * (`channelOf`). A candidate with no row (deleted between the reads) is nobody. Pure.
 */
export function unreachedNames(candidates: readonly Pick<PastPlayer, "id" | "name">[], rows: readonly ReachRow[], reach: RefillReach, range: Pick<Event, "levelMin" | "levelMax">): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const devices = new Set(rows.filter((r) => r.push).map((r) => r.id));
  return candidates.flatMap((c) => {
    const row = byId.get(c.id);
    if (!row || !admits(range, row) || channelOf(row, reach, devices) !== null) return [];
    const name = firstName(c.name);
    return name ? [name] : [];
  });
}

/** The line's names: at most `UNREACHED_SHOWN`, and how many more. Pure. */
export function unreachedLine(names: readonly string[]): { shown: string[]; more: number } {
  return { shown: names.slice(0, UNREACHED_SHOWN), more: Math.max(0, names.length - UNREACHED_SHOWN) };
}

/**
 * The names for the organiser's line, from the past players the page read already: the candidates
 * (pure), then one read of what the offer decides on, bounded and down the players' key, with push as
 * an `exists` down `push_subscriptions_player_idx`. Nothing to read, no read.
 */
export async function unreachedPartners(db: Db, ev: Pick<Event, "levelMin" | "levelMax">, list: readonly PastPlayer[], here: UnreachedHere, reach: RefillReach, now: Date): Promise<string[]> {
  const candidates = unreachedCandidates(list, here, now).slice(0, UNREACHED_READ_MAX);
  if (candidates.length === 0) return [];
  const rows = await db
    .select({
      id: players.id,
      level: players.level,
      telegramId: players.telegramId,
      phone: players.phone,
      email: players.email,
      emailNotifications: players.emailNotifications,
      // An alias for the inner table and the outer one named by hand: in a select from one table drizzle writes columns bare.
      push: sql<boolean>`exists (select 1 from ${pushSubscriptions} ps where ps.player_id = ${players}.id)`,
    })
    .from(players)
    .where(inArray(players.id, candidates.map((c) => c.id)));
  return unreachedNames(candidates, rows.map((r) => ({ ...r, push: Boolean(r.push) })), reach, ev);
}
