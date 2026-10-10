import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, events, groups } from "@/db/schema";
import { BEST_TIMES, bestTimes, freeFeedOf, type BestTime, type BestTimesClub, type TimePattern } from "./bestTimes";
import { CITIES, cityOf, venueInCity, type City } from "./cities";
import { parseMatchLength } from "./matchLength";
import { getPlayerHistory, timePatternsOf } from "./queries";
import { venueSlugFor } from "./venueBoard";

/**
 * Where the best times come from: which clubs, whose habits. Every read here is bounded and reads the
 * clubs' cached feeds, never a feed itself (rule 12: the hourly job fetches; a request reads). The
 * ranking is pure and lives in `bestTimes.ts`.
 *
 * - /play reads the clubs of one city (`courtsFreeInCity`), and the viewer's own history when signed in.
 * - The crew's Telegram group and a player's private chat read the crew's or the player's own clubs,
 *   and the clubs of the city those are in (`bestTimesForChat`).
 * - The create form needs no read of its own: the club rows it already lists carry their feeds
 *   (`venuesForPicking`).
 */

/** The most clubs one read hands to the ranking. */
const MAX_CLUBS = 30;
/** The most of a crew's or a player's own clubs the ranking looks at. */
const MAX_OWN = 12;
/** /play offers the free courts while a city has fewer open games than this (the owner's decision C of 9 October 2026 uses three for the strip of games). */
export const PLAY_FEW_GAMES = 3;

/** Live clubs with a feed read lately, among these slugs: one read on the primary key. */
async function feedsForSlugs(db: Db, slugs: readonly string[], now: Date): Promise<BestTimesClub[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select({ slug: clubs.slug, name: clubs.name, availability: clubs.availability })
    .from(clubs)
    .where(and(inArray(clubs.slug, [...slugs]), isNotNull(clubs.approvedAt), isNull(clubs.rejectedAt), gte(clubs.availabilityAt, new Date(now.getTime() - BEST_TIMES.freshMs))))
    .limit(MAX_OWN);
  return rows.flatMap((r) => {
    const feed = freeFeedOf(r.availability, now);
    return feed ? [{ slug: r.slug, name: r.name, feed }] : [];
  });
}

/** Live clubs in a city with a feed read lately: its own city slug, or its zone and a slug the city knows. One bounded read. */
async function feedsInCity(db: Db, city: City, now: Date): Promise<BestTimesClub[]> {
  const rows = await db
    .select({ slug: clubs.slug, name: clubs.name, city: clubs.city, tz: clubs.tz, availability: clubs.availability })
    .from(clubs)
    .where(and(isNotNull(clubs.approvedAt), isNull(clubs.rejectedAt), gte(clubs.availabilityAt, new Date(now.getTime() - BEST_TIMES.freshMs)), or(eq(clubs.city, city.slug), eq(clubs.tz, city.tz))))
    .orderBy(asc(clubs.name))
    .limit(MAX_CLUBS);
  return rows.flatMap((r) => {
    if (r.city !== city.slug && !venueInCity(city, r.slug, r.tz ?? "")) return [];
    const feed = freeFeedOf(r.availability, now);
    return feed ? [{ slug: r.slug, name: r.name, feed }] : [];
  });
}

const hasFree = (cs: readonly BestTimesClub[]) => cs.some((c) => (c.feed?.slots.length ?? 0) > 0);

/**
 * /play's "Courts free this week": the best times at the city's clubs that share a feed. A signed-in
 * viewer's own clubs and times come first; anybody else gets the soonest. Empty when no club in the
 * city shows a free court, and the page then shows no section at all.
 */
export async function courtsFreeInCity(db: Db, city: City, viewerId: string | null, now: Date, limit: number = BEST_TIMES.limit): Promise<BestTime[]> {
  const near = await feedsInCity(db, city, now);
  if (!hasFree(near)) return [];
  const history = viewerId ? await getPlayerHistory(db, viewerId, 60) : [];
  const usual = new Set(history.flatMap((h) => (h.venueSlug ? [h.venueSlug] : [])));
  return bestTimes({ clubs: near.map((c) => ({ ...c, usual: usual.has(c.slug) })), patterns: timePatternsOf(history), lengthMinutes: parseMatchLength(history[0]?.durationMinutes) ?? 90, now, limit });
}

/**
 * The best times for a chat: a crew's own Telegram group (its matches, its usual court, its weekly
 * slot) or a player's private chat (their matches, the chat's usual court). Their own clubs count as
 * usual; the clubs of the city those are in follow. The length is the one they played last.
 */
export async function bestTimesForChat(db: Db, o: { groupId: string | null; playerId: string | null; venueName: string | null; tz: string | null }, now: Date, limit: number = BEST_TIMES.limit): Promise<{ times: BestTime[]; lengthMinutes: number }> {
  const crew = o.groupId ? (await db.select().from(groups).where(eq(groups.id, o.groupId)).limit(1))[0] ?? null : null;
  const history = crew
    ? await db
        .select({ startsAt: events.startsAt, tz: events.tz, venueSlug: events.venueSlug, durationMinutes: events.durationMinutes })
        .from(events)
        .where(and(eq(events.groupId, crew.id), ne(events.status, "cancelled")))
        .orderBy(desc(events.startsAt))
        .limit(30)
    : o.playerId
      ? await getPlayerHistory(db, o.playerId, 60)
      : [];
  const patterns: TimePattern[] = timePatternsOf(history);
  if (crew?.recurDow != null && crew.recurTime) patterns.unshift({ dow: crew.recurDow, time: crew.recurTime });
  const slugs: string[] = [];
  const add = (s: string | null | undefined) => {
    if (s && !slugs.includes(s) && slugs.length < MAX_OWN) slugs.push(s);
  };
  // The usual courts by name, each read once against the club list; then where they actually played.
  for (const name of [o.venueName, crew?.venueName]) if (name) add(await venueSlugFor(db, name));
  for (const h of history) add(h.venueSlug);
  const tz = o.tz ?? crew?.tz ?? history[0]?.tz ?? null;
  const city = tz ? (slugs.map((s) => cityOf(tz, s)).find(Boolean) ?? CITIES.find((c) => c.tz === tz && c.needles.length === 0) ?? null) : null;
  const own = await feedsForSlugs(db, slugs, now);
  const near = city ? (await feedsInCity(db, city, now)).filter((c) => !slugs.includes(c.slug)) : [];
  const lengthMinutes = parseMatchLength(history[0]?.durationMinutes) ?? 90;
  return { times: bestTimes({ clubs: [...own.map((c) => ({ ...c, usual: true })), ...near], patterns, lengthMinutes, now, limit }), lengthMinutes };
}
