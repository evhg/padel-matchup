import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, events, groups, type Club } from "@/db/schema";
import { cacheBetween, freeCourtsState } from "@/lib/booking/availability";
import { BEST_TIMES, bestTimes, freeAt, freeFeedOf, type BestTime, type BestTimesClub, type FreeFeed, type TimePattern } from "./bestTimes";
import { CITIES, cityOf, venueInCity, type City } from "./cities";
import { defaultLength, parseMatchLength } from "./matchLength";
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
 * - The create form reads the feeds of the person's own, here and nearby clubs, twelve at most
 *   (`clubFeeds`, from `venuesForPicking`), never every club it lists.
 *
 * Which clubs: a club that runs its page, or the directory's own row (the clubs whose links
 * `mayPrepareFor` trusts), with a zone (a club without one would be read in UTC). Which cache: the
 * club's own feed when it shares one, else a platform's fresh read, named as the platform's
 * (`freeCourtsState`, the same rule as the club page, DECIDING rule 35). How much: the cache cut in
 * the database to the seven days the ranking can use (`cacheBetween`), so a read never carries the
 * days that are over or out of reach (AGENTS.md rule 12, the egress in docs/OPERATING.md).
 */

/** The most clubs one read hands to the ranking. */
const MAX_CLUBS = 30;
/** The most of a crew's or a player's own clubs the ranking looks at. */
const MAX_OWN = 12;
/** /play offers the free courts while a city has fewer open games than this (the owner's decision C of 9 October 2026 uses three for the strip of games). */
export const PLAY_FEW_GAMES = 3;

/** What a read of the free courts takes from a club row: the cache cut to the next seven days, and what decides which cache wins. */
export const clubFeedColumns = (now: Date) => ({
  slug: clubs.slug,
  name: clubs.name,
  city: clubs.city,
  tz: clubs.tz,
  availabilityUrl: clubs.availabilityUrl,
  availabilityKind: clubs.availabilityKind,
  availability: cacheBetween(now, new Date(now.getTime() + BEST_TIMES.horizonMs)),
});

/** The clubs whose free times are offered: vetted (`mayPrepareFor`), with a zone, and a cache written lately. */
const offered = (now: Date) => and(isNull(clubs.rejectedAt), or(isNotNull(clubs.approvedAt), eq(clubs.source, "directory")), isNotNull(clubs.tz), gte(clubs.availabilityAt, new Date(now.getTime() - BEST_TIMES.freshMs)));

/** The feed a row's cache gives, after the club page's rule on whose times win: the club's own feed, else a platform's fresh read. */
function feedOfRow(r: Pick<Club, "availability" | "availabilityUrl" | "availabilityKind">, now: Date): FreeFeed | null {
  const state = freeCourtsState(r, now);
  return state.kind === "feed" || state.kind === "platform" ? freeFeedOf(state.a, now) : null;
}

/**
 * Does this club still show a free court then, by the same rule every list reads (`feedOfRow`)? The
 * chat's buttons ask it again at the tap, because a court free when the bot answered may be booked
 * since. Pure, on a row already read.
 */
export function freeAtClub(c: Pick<Club, "availability" | "availabilityUrl" | "availabilityKind">, start: Date, minutes: number, now: Date): "free" | "busy" | "unknown" {
  return freeAt(feedOfRow(c, now), start, minutes, now);
}

/** The offered clubs among these slugs, with a feed a screen may use: one read on the primary key, twelve at most. */
async function feedsForSlugs(db: Db, slugs: readonly string[], now: Date): Promise<BestTimesClub[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select(clubFeedColumns(now))
    .from(clubs)
    .where(and(inArray(clubs.slug, [...slugs].slice(0, MAX_OWN)), offered(now)))
    .limit(MAX_OWN);
  return rows.flatMap((r) => {
    const feed = feedOfRow(r, now);
    return feed ? [{ slug: r.slug, name: r.name, feed }] : [];
  });
}

/** The create form's free times: the feeds of these clubs (the person's own, here and nearby), twelve at most, by slug. */
export async function clubFeeds(db: Db, slugs: readonly string[], now: Date): Promise<Map<string, FreeFeed>> {
  return new Map((await feedsForSlugs(db, slugs, now)).map((c) => [c.slug, c.feed!]));
}

/**
 * The offered clubs of a city with a feed a screen may use: its own city slug, or its zone and a slug
 * the city knows. One bounded read, the city's own rows first, so the clubs of another city in the
 * same zone (Bangkok's beside Phuket's) never take the places before the filter.
 */
async function feedsInCity(db: Db, city: City, now: Date): Promise<BestTimesClub[]> {
  const rows = await db
    .select(clubFeedColumns(now))
    .from(clubs)
    .where(and(offered(now), or(eq(clubs.city, city.slug), eq(clubs.tz, city.tz))))
    .orderBy(sql`(${clubs.city} = ${city.slug}) desc nulls last`, asc(clubs.name))
    .limit(MAX_CLUBS);
  return rows.flatMap((r) => {
    if (r.city !== city.slug && !venueInCity(city, r.slug, r.tz ?? "")) return [];
    const feed = feedOfRow(r, now);
    return feed ? [{ slug: r.slug, name: r.name, feed }] : [];
  });
}

const hasFree = (cs: readonly BestTimesClub[]) => cs.some((c) => (c.feed?.slots.length ?? 0) > 0);

/**
 * /play's free courts: the best times at the city's clubs. A signed-in viewer's own clubs and times
 * come first; anybody else gets the soonest. Ranked for the length the create form opens at (90
 * minutes), because each row opens it: a 60-minute gap would open as a 90-minute match the club cannot
 * hold. Empty when no club in the city shows a free court, and the page then shows no section at all.
 */
export async function courtsFreeInCity(db: Db, city: City, viewerId: string | null, now: Date, limit: number = BEST_TIMES.limit): Promise<BestTime[]> {
  const near = await feedsInCity(db, city, now);
  if (!hasFree(near)) return [];
  const history = viewerId ? await getPlayerHistory(db, viewerId, 60) : [];
  const usual = new Set(history.flatMap((h) => (h.venueSlug ? [h.venueSlug] : [])));
  return bestTimes({ clubs: near.map((c) => ({ ...c, usual: usual.has(c.slug) })), patterns: timePatternsOf(history), lengthMinutes: defaultLength("match"), now, limit });
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
  // The usual courts by name, each name read once against the club list (a crew's chat and the crew
  // carry the same name); then where they actually played.
  for (const name of new Set([o.venueName, crew?.venueName].filter((n): n is string => Boolean(n)))) add(await venueSlugFor(db, name));
  for (const h of history) add(h.venueSlug);
  const tz = o.tz ?? crew?.tz ?? history[0]?.tz ?? null;
  const city = tz ? (slugs.map((s) => cityOf(tz, s)).find(Boolean) ?? CITIES.find((c) => c.tz === tz && c.needles.length === 0) ?? null) : null;
  const own = await feedsForSlugs(db, slugs, now);
  const near = city ? (await feedsInCity(db, city, now)).filter((c) => !slugs.includes(c.slug)) : [];
  const lengthMinutes = parseMatchLength(history[0]?.durationMinutes) ?? 90;
  return { times: bestTimes({ clubs: [...own.map((c) => ({ ...c, usual: true })), ...near], patterns, lengthMinutes, now, limit }), lengthMinutes };
}
