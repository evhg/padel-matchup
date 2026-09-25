import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, demandSignals, events, facts, players, pushSubscriptions, slots, type Club, type ClubAvailability, type DemandSignal, type Player } from "@/db/schema";
import { isValidTimeZone, utcToZonedParts } from "@/lib/dates";
import { WANT_COOLDOWN_MS, weekdayOf } from "./demand";
import { recordFact } from "./facts";

/**
 * A free court, offered to the player who asked to play then.
 *
 * The club's promise in docs/VISION.md is an off-peak court hour filled from Kicksmash. Two halves of
 * it existed and never met: a club that shares a feed of its free courts (`src/lib/booking/
 * availability.ts`, read every hour), and a player who said "Tuesdays around two at Rawai"
 * (`demand.ts`), whose want was answered only by a match somebody else had already made. When the
 * feed shows a court free at the club a want names, on its day and inside its hours, the player hears
 * once, with one button that opens the match form at that club and that hour.
 *
 * One notice, never a stream (docs/DECIDING.md rules 5 and 16). A want hears at most once in six hours,
 * the cooldown the match notices already keep, and shares it with them. An hour is offered only when
 * it starts within that cooldown, so by the time a want may hear again, every hour it was offered has
 * begun: no want hears about the same court twice. And a want hears about one court a day at most:
 * "any day, any hour at Warehaus", which is the want production holds, would otherwise hear three
 * times a day for a month. The claim is the want's own `notified_at` and the day is read from the
 * fact log, so this needs no table and no column of its own.
 */
const HOUR_MS = 3600_000;

export const COURT_OFFERS = {
  /** Closer than this, four people cannot get there. */
  minLeadMs: 2 * HOUR_MS,
  /** No further ahead than the cooldown: the "never twice" above rests on it. */
  maxLeadMs: WANT_COOLDOWN_MS,
  /** One court a day for one want. */
  perWantMs: 24 * HOUR_MS,
  /** A feed read longer ago than this may have lost the court to a booking since. */
  freshMs: 2 * HOUR_MS,
  /** Notices one hourly run may send. The rest wait for the next run, while their hour is still ahead. */
  perRun: 20,
  clubsPerRun: 30,
  candidates: 200,
} as const;

/** The fact each want that was offered a court gets: the count the owner reads, and the day rule's memory. */
export const COURT_OFFERED = "demand.court_offered";

export type FreeHour = { start: Date; end: Date; date: string; time: string; free: number };
export type CourtOfferClub = Pick<Club, "slug" | "name"> & { tz: string };
export type CourtOffer = { playerId: string; club: CourtOfferClub; hour: FreeHour; wantIds: string[] };
type WantRow = Pick<DemandSignal, "id" | "playerId" | "venueSlug" | "onDate" | "weekday" | "fromTime" | "toTime">;

/** The hours in a club's feed that people could still get to, soonest first, as the club's clock reads them. Pure. */
export function offerableHours(a: ClubAvailability | null | undefined, now: Date): FreeHour[] {
  if (!a || a.error || !isValidTimeZone(a.tz)) return [];
  const from = now.getTime() + COURT_OFFERS.minLeadMs;
  const to = now.getTime() + COURT_OFFERS.maxLeadMs;
  const out: FreeHour[] = [];
  for (const s of a.slots) {
    const start = new Date(s.start);
    const end = new Date(s.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || !(s.free >= 1)) continue;
    if (start.getTime() < from || start.getTime() > to) continue;
    out.push({ start, end, ...utcToZonedParts(start, a.tz), free: s.free });
  }
  return out.sort((x, y) => x.start.getTime() - y.start.getTime());
}

/**
 * Does this hour answer this want? The reading `matchingWants` gives a match: a dated want is for that
 * date, an undated one for its weekday or any day, and the hour starts inside the window. Pure.
 */
export function wantFitsHour(w: Pick<DemandSignal, "onDate" | "weekday" | "fromTime" | "toTime">, h: Pick<FreeHour, "date" | "time">): boolean {
  if (w.onDate ? w.onDate !== h.date : w.weekday !== null && w.weekday !== weekdayOf(h.date)) return false;
  if (w.fromTime && h.time < w.fromTime) return false;
  if (w.toTime && h.time > w.toTime) return false;
  return true;
}

/**
 * Who hears about which hour, in one place and pure:
 * - a want hears about the first free hour at its own club that fits it;
 * - an hour a match at the club already starts in is that match's to fill: the want hears about the
 *   match (the wants sweep), not about a court beside it;
 * - somebody who already holds a seat at the club that day needs no court;
 * - one notice per person per run: the hour that answers most of their wants, the soonest of those,
 *   and it answers every want of theirs that hour fits.
 */
export function planCourtOffers(input: {
  clubs: { club: CourtOfferClub; hours: FreeHour[] }[];
  wants: WantRow[];
  matches: { venueSlug: string; startsAt: Date }[];
  /** "slug|date|playerId": a seat at that club on that local day. */
  playing: Set<string>;
}): CourtOffer[] {
  const byClub = new Map(input.clubs.map((c) => [c.club.slug, c]));
  const taken = (slug: string, h: FreeHour) => input.matches.some((m) => m.venueSlug === slug && m.startsAt >= h.start && m.startsAt < h.end);
  const byPlayer = new Map<string, WantRow[]>();
  for (const w of input.wants) if (w.venueSlug && byClub.has(w.venueSlug)) byPlayer.set(w.playerId, [...(byPlayer.get(w.playerId) ?? []), w]);
  const plans: CourtOffer[] = [];
  for (const [playerId, mine] of byPlayer) {
    let best: CourtOffer | null = null;
    for (const w of mine) {
      const c = byClub.get(w.venueSlug!)!;
      for (const h of c.hours) {
        if (!wantFitsHour(w, h) || taken(c.club.slug, h) || input.playing.has(`${c.club.slug}|${h.date}|${playerId}`)) continue;
        const answered = mine.filter((x) => x.venueSlug === c.club.slug && wantFitsHour(x, h)).map((x) => x.id);
        if (!best || answered.length > best.wantIds.length || (answered.length === best.wantIds.length && h.start < best.hour.start)) best = { playerId, club: c.club, hour: h, wantIds: answered };
      }
    }
    if (best) plans.push(best);
  }
  return plans.sort((a, b) => a.hour.start.getTime() - b.hour.start.getTime());
}

/**
 * The offers this hour's run may make, each with the person it goes to. Bounded at every step and all
 * of it in the hourly job (rule 12): one read of the clubs with a fresh feed, and only when one has an
 * hour ahead, one of the wants at those clubs (on `demand_venue_idx`) and of the courts they heard of
 * today, one of the clubs' matches (on `events_venue_slug_idx`) and the seats in them, one of the
 * people. Somebody no channel reaches is left out here, so a claim never silences a want for a notice
 * that could not go.
 */
export async function courtOffersDue(db: Db, now: Date, reach: { telegram: boolean; email: boolean; push: boolean }): Promise<(CourtOffer & { player: Player })[]> {
  const fed = await db
    .select({ slug: clubs.slug, name: clubs.name, availability: clubs.availability })
    .from(clubs)
    .where(and(isNotNull(clubs.approvedAt), isNull(clubs.rejectedAt), gte(clubs.availabilityAt, new Date(now.getTime() - COURT_OFFERS.freshMs))))
    .orderBy(desc(clubs.availabilityAt))
    .limit(COURT_OFFERS.clubsPerRun);
  const open = fed.flatMap((c) => {
    const hours = offerableHours(c.availability, now);
    return hours.length && c.availability ? [{ club: { slug: c.slug, name: c.name, tz: c.availability.tz }, hours }] : [];
  });
  if (open.length === 0) return [];
  const slugs = open.map((c) => c.club.slug);

  const quiet = await db
    .select()
    .from(demandSignals)
    .where(and(inArray(demandSignals.venueSlug, slugs), gt(demandSignals.expiresAt, now), or(isNull(demandSignals.notifiedAt), lte(demandSignals.notifiedAt, new Date(now.getTime() - WANT_COOLDOWN_MS)))))
    // The longest quiet first, so the wants that heard today cannot crowd out the ones that did not.
    .orderBy(sql`${demandSignals.notifiedAt} asc nulls first`, asc(demandSignals.createdAt))
    .limit(COURT_OFFERS.candidates);
  if (quiet.length === 0) return [];
  // One court a day: the wants a court was offered to in the last day, from the fact log (on `facts_subject_idx`).
  const offered = await db
    .select({ id: facts.subjectId })
    .from(facts)
    .where(and(eq(facts.subjectType, "want"), inArray(facts.subjectId, quiet.map((w) => w.id)), eq(facts.kind, COURT_OFFERED), gt(facts.at, new Date(now.getTime() - COURT_OFFERS.perWantMs))));
  const today = new Set(offered.map((f) => f.id));
  const wants = quiet.filter((w) => !today.has(w.id));
  if (wants.length === 0) return [];

  // A day either side of the hours on offer covers the club's whole local day, wherever it is.
  const matches = await db
    .select({ id: events.id, venueSlug: events.venueSlug, startsAt: events.startsAt })
    .from(events)
    .where(and(inArray(events.venueSlug, slugs), gte(events.startsAt, new Date(now.getTime() - 24 * HOUR_MS)), lt(events.startsAt, new Date(now.getTime() + COURT_OFFERS.maxLeadMs + 24 * HOUR_MS)), inArray(events.status, ["open", "full"])))
    .limit(COURT_OFFERS.candidates);
  const wanters = [...new Set(wants.map((w) => w.playerId))];
  const seats = matches.length
    ? await db
        .select({ eventId: slots.eventId, playerId: slots.playerId })
        .from(slots)
        .where(and(inArray(slots.eventId, matches.map((m) => m.id)), inArray(slots.playerId, wanters), inArray(slots.status, ["joined", "confirmed"])))
    : [];
  const tzOf = new Map(open.map((c) => [c.club.slug, c.club.tz]));
  const matchById = new Map(matches.map((m) => [m.id, m]));
  const playing = new Set(
    seats.flatMap((s) => {
      const m = matchById.get(s.eventId);
      const tz = m?.venueSlug ? tzOf.get(m.venueSlug) : undefined;
      return m?.venueSlug && tz && s.playerId ? [`${m.venueSlug}|${utcToZonedParts(m.startsAt, tz).date}|${s.playerId}`] : [];
    }),
  );
  const plans = planCourtOffers({ clubs: open, wants, matches: matches.flatMap((m) => (m.venueSlug ? [{ venueSlug: m.venueSlug, startsAt: m.startsAt }] : [])), playing });
  if (plans.length === 0) return [];

  const people = await db.select().from(players).where(inArray(players.id, plans.map((p) => p.playerId)));
  const pushable = reach.push
    ? new Set((await db.selectDistinct({ playerId: pushSubscriptions.playerId }).from(pushSubscriptions).where(inArray(pushSubscriptions.playerId, people.map((p) => p.id)))).map((r) => r.playerId))
    : new Set<string>();
  const byId = new Map(people.map((p) => [p.id, p]));
  return plans.flatMap((plan) => {
    const p = byId.get(plan.playerId);
    const reachable = p && ((reach.telegram && p.telegramId) || (reach.email && p.email && p.emailNotifications) || pushable.has(p.id));
    return p && reachable ? [{ ...plan, player: p }] : [];
  });
}

/**
 * The offer's claim, before anything is sent: the wants it answers go quiet now, so a second run, or a
 * run beside this one, finds them taken. Returns the ids this call won; none means another run has them.
 * Each want won gets its fact, which is also what keeps it to one court a day.
 */
export async function claimCourtOffer(db: Db, offer: CourtOffer, now: Date): Promise<string[]> {
  if (offer.wantIds.length === 0) return [];
  const rows = await db
    .update(demandSignals)
    .set({ notifiedAt: now })
    .where(and(inArray(demandSignals.id, offer.wantIds), or(isNull(demandSignals.notifiedAt), lte(demandSignals.notifiedAt, new Date(now.getTime() - WANT_COOLDOWN_MS)))))
    .returning({ id: demandSignals.id });
  for (const r of rows) {
    await recordFact(db, {
      kind: COURT_OFFERED,
      channel: "cron",
      actorPlayerId: offer.playerId,
      subject: { type: "want", id: r.id },
      code: null,
      venueSlug: offer.club.slug,
      data: { startsAt: offer.hour.start.toISOString(), free: offer.hour.free },
      at: now,
    });
  }
  return rows.map((r) => r.id);
}

/**
 * The match form at that club and that hour: the form's own `?venue=` door (a venue board's "make a
 * match here"), with the day, the time and the club's zone. The venue name finds the club's own slug
 * (`venueSlugFor`), and the form lists the match on the club's board. From Telegram it carries the
 * chat's ticket as well, so the card of the match comes back to this chat, as from the button of /new.
 */
export function courtOfferLink(base: string, offer: Pick<CourtOffer, "club" | "hour">, telegramTicket?: string | null): string {
  const q = new URLSearchParams({ venue: offer.club.name, date: offer.hour.date, time: offer.hour.time, tz: offer.club.tz });
  if (telegramTicket) q.set("tg", telegramTicket);
  return `${base}/?${q.toString()}`;
}
