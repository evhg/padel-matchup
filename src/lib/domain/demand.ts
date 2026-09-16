import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@/db";
import { demandSignals, events, players, pushSubscriptions, slots, type DemandSignal, type Event, type Player } from "@/db/schema";
import { listedClub, venueSlug as slugOf } from "./venueBoard";
import { cityInText } from "./cities";
import { utcToZonedParts, WEEKDAY_WORDS } from "@/lib/dates";
import { cityOf } from "./cities";
import { DomainError } from "./errors";
import { channelOf, recordFact } from "./facts";

/**
 * Demand, recorded.
 *
 * Every other table here is supply: a match exists and people join it. The one thing a player cannot
 * do in the app is the thing they actually do in the chat — say "I want to play Tuesday at two near
 * Rawai" — and so the app waits for somebody to post a match and hopes the right people see it.
 *
 * A want is deliberately loose: a weekday or a single date, a window or any hour, a court or a city.
 * Loose is the point. A want that has to be exact is a booking, and bookings already work.
 */

const DAY_MS = 86_400_000;
/** A month. A want nobody matched in a month is not a want any more. */
export const WANT_TTL_MS = 30 * DAY_MS;
/** Six hours between buzzes for one want, so a busy club does not empty somebody's battery. */
export const WANT_COOLDOWN_MS = 6 * 3600_000;
/** What one player may hold at once. Past this it is not a want, it is a subscription to everything. */
export const WANT_MAX_PER_PLAYER = 10;
/** Rows the matcher will look at, and people it will tell. Both bounded so a match never fans out wide. */
const WANT_CANDIDATE_MAX = 200;
const WANT_FANOUT_MAX = 20;

export type WantInput = {
  playerId: string;
  /** 0 = Sunday. Null with no date means any day. */
  weekday?: number | null;
  /** "2026-09-15", when the want is for one day only. */
  onDate?: string | null;
  fromTime?: string | null;
  toTime?: string | null;
  venueSlug?: string | null;
  citySlug?: string | null;
  source?: string | null;
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The weekday a local date falls on, 0 = Sunday, read off the date itself rather than a zone. */
export const weekdayOf = (dateStr: string): number =>
  new Date(Date.UTC(Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10)))).getUTCDay();

/**
 * Record a want. A place is required: a want with neither a court nor a city would match a match on
 * another continent, which is not a want, it is noise.
 */
export async function recordWant(db: Db, input: WantInput, now = new Date()): Promise<DemandSignal> {
  const venueSlug = input.venueSlug?.trim() || null;
  const citySlug = input.citySlug?.trim() || null;
  if (!venueSlug && !citySlug) throw new DomainError("invalid", "place");
  const onDate = input.onDate && DATE_RE.test(input.onDate) ? input.onDate : null;
  const fromTime = input.fromTime && TIME_RE.test(input.fromTime) ? input.fromTime : null;
  const toTime = input.toTime && TIME_RE.test(input.toTime) ? input.toTime : null;
  // A date says which day already; keeping a weekday beside it would let the two disagree.
  const weekday = onDate === null && typeof input.weekday === "number" && input.weekday >= 0 && input.weekday <= 6 ? input.weekday : null;
  if (fromTime && toTime && toTime < fromTime) throw new DomainError("invalid", "time");

  const mine = await listWants(db, input.playerId, now);
  if (mine.length >= WANT_MAX_PER_PLAYER) throw new DomainError("too_many");
  // The same want twice is one want. Saying it again pushes the expiry out, which is what repeating it means.
  const same = mine.find(
    (w) => w.venueSlug === venueSlug && w.citySlug === citySlug && w.weekday === weekday && w.onDate === onDate && w.fromTime === fromTime && w.toTime === toTime,
  );
  const expiresAt = onDate ? new Date(new Date(`${onDate}T23:59:00Z`).getTime() + DAY_MS) : new Date(now.getTime() + WANT_TTL_MS);
  if (same) {
    const [renewed] = await db.update(demandSignals).set({ expiresAt }).where(eq(demandSignals.id, same.id)).returning();
    return renewed;
  }
  const [row] = await db
    .insert(demandSignals)
    .values({ playerId: input.playerId, weekday, onDate, fromTime, toTime, venueSlug, citySlug, expiresAt })
    .returning();
  await recordFact(db, {
    kind: "demand.recorded",
    channel: channelOf(input.source),
    actorPlayerId: input.playerId,
    subject: { type: "want", id: row.id },
    code: null,
    city: citySlug,
    venueSlug,
    data: { weekday, onDate, fromTime, toTime },
  });
  return row;
}

/** One player's live wants, oldest first. */
export async function listWants(db: Db, playerId: string, now = new Date()): Promise<DemandSignal[]> {
  return db
    .select()
    .from(demandSignals)
    .where(and(eq(demandSignals.playerId, playerId), gt(demandSignals.expiresAt, now)))
    .orderBy(asc(demandSignals.createdAt))
    .limit(WANT_MAX_PER_PLAYER);
}

/** Drop one, by its owner. Returns false when it was never theirs, rather than throwing. */
export async function dropWant(db: Db, id: string, playerId: string): Promise<boolean> {
  const rows = await db.delete(demandSignals).where(and(eq(demandSignals.id, id), eq(demandSignals.playerId, playerId))).returning({ id: demandSignals.id });
  return rows.length > 0;
}

/**
 * The wants a match answers. Day, hour and place are matched in SQL against the indexes, because this
 * runs when a match is created and must not grow with the table (rule 12); who can actually be told
 * is decided afterwards, on a bounded list.
 */
export async function matchingWants(db: Db, ev: Event, now = new Date()): Promise<DemandSignal[]> {
  const city = cityOf(ev.tz, ev.venueSlug)?.slug ?? null;
  if (!ev.venueSlug && !city) return [];
  const { date, time } = utcToZonedParts(ev.startsAt, ev.tz);
  const dow = weekdayOf(date);
  const place = [
    ...(ev.venueSlug ? [eq(demandSignals.venueSlug, ev.venueSlug)] : []),
    ...(city ? [eq(demandSignals.citySlug, city)] : []),
  ];
  return db
    .select()
    .from(demandSignals)
    .where(
      and(
        or(...place),
        gt(demandSignals.expiresAt, now),
        // A dated want is for that date; an undated one is for that weekday, or for any day.
        or(eq(demandSignals.onDate, date), and(isNull(demandSignals.onDate), or(isNull(demandSignals.weekday), eq(demandSignals.weekday, dow)))),
        or(isNull(demandSignals.fromTime), lte(demandSignals.fromTime, time)),
        or(isNull(demandSignals.toTime), gte(demandSignals.toTime, time)),
        // Quiet since the last buzz. `notifiedAt` is null for a want nobody has answered yet.
        or(isNull(demandSignals.notifiedAt), lte(demandSignals.notifiedAt, new Date(now.getTime() - WANT_COOLDOWN_MS))),
      ),
    )
    .limit(WANT_CANDIDATE_MAX);
}

/**
 * Who to tell about a match, because they asked for one like it. Everyone already in the match, the
 * organiser, and anyone the caller has told already are dropped; so is anyone the match's level range
 * does not admit, because chasing a player a match cannot take is worse than silence.
 */
export async function wantAudience(db: Db, ev: Event, now = new Date(), exclude: Iterable<string> = []): Promise<{ players: Player[]; signalIds: string[] }> {
  const wants = await matchingWants(db, ev, now);
  if (wants.length === 0) return { players: [], signalIds: [] };
  const out = new Set(exclude);
  out.add(ev.creatorPlayerId);
  const taken = await db.select({ playerId: slots.playerId }).from(slots).where(eq(slots.eventId, ev.id));
  for (const r of taken) if (r.playerId) out.add(r.playerId);

  const byPlayer = new Map<string, string[]>();
  for (const w of wants) {
    if (out.has(w.playerId)) continue;
    byPlayer.set(w.playerId, [...(byPlayer.get(w.playerId) ?? []), w.id]);
  }
  const ids = [...byPlayer.keys()].slice(0, WANT_CANDIDATE_MAX);
  if (ids.length === 0) return { players: [], signalIds: [] };

  const rows = await db.select().from(players).where(inArray(players.id, ids));
  const admitted = rows.filter((p) => {
    if (ev.levelMin === null && ev.levelMax === null) return true;
    if (p.level === null) return false;
    if (ev.levelMin !== null && p.level < ev.levelMin) return false;
    if (ev.levelMax !== null && p.level > ev.levelMax) return false;
    return true;
  });
  if (admitted.length === 0) return { players: [], signalIds: [] };
  // A want is answered by a notice, and a notice needs somewhere to land: push, or an address.
  const subscribed = await db.selectDistinct({ playerId: pushSubscriptions.playerId }).from(pushSubscriptions).where(inArray(pushSubscriptions.playerId, admitted.map((p) => p.id)));
  const pushable = new Set(subscribed.map((r) => r.playerId));
  const reachable = admitted.filter((p) => pushable.has(p.id) || (p.email && p.emailNotifications)).slice(0, WANT_FANOUT_MAX);
  return { players: reachable, signalIds: reachable.flatMap((p) => byPlayer.get(p.id) ?? []) };
}

/** Start the cooldown on the wants a notice just answered. */
export async function markWantsNotified(db: Db, signalIds: string[], now = new Date()): Promise<void> {
  if (signalIds.length === 0) return;
  await db.update(demandSignals).set({ notifiedAt: now }).where(inArray(demandSignals.id, signalIds));
}

/** Wants belonging to a player who is leaving. Called by account deletion; nothing else may need it. */
export async function dropWantsFor(db: Db, playerId: string): Promise<number> {
  const rows = await db.delete(demandSignals).where(eq(demandSignals.playerId, playerId)).returning({ id: demandSignals.id });
  return rows.length;
}

/** Rows whose day has passed, cleared by the nightly tick so the indexes stay small. */
export async function pruneWants(db: Db, now = new Date()): Promise<number> {
  const rows = await db.delete(demandSignals).where(lte(demandSignals.expiresAt, now)).returning({ id: demandSignals.id });
  return rows.length;
}

/**
 * Matches with a seat free that nobody's want has been checked against yet.
 *
 * One sweep rather than a call in each of the five places a match can be created — the web form, the
 * API, the Telegram bot, a group's weekly slot and a series. A want is a standing preference, not an
 * alarm: answering "somebody made the Tuesday match you asked for" within the hour is the same thing
 * as answering it instantly, and the case that really cannot wait — a seat opening tonight — is the
 * refill, which pushes at once and now reads these wants too.
 */
export async function findWantsDue(db: Db, now = new Date()): Promise<Event[]> {
  const rows = await db
    .select({ event: events })
    .from(events)
    .innerJoin(slots, and(eq(slots.eventId, events.id), lte(slots.position, events.capacity), inArray(slots.status, ["empty", "declined"])))
    .where(and(eq(events.status, "open"), isNull(events.wantsNoticeAt), gt(events.startsAt, now), isNotNull(events.venueSlug)))
    .groupBy(events.id)
    .orderBy(asc(events.startsAt))
    .limit(30);
  return rows.map((r) => r.event);
}

/** Claim the sweep for one match, so two ticks cannot both answer the same wants. */
export async function claimWantsNotice(db: Db, eventId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(events)
    .set({ wantsNoticeAt: now })
    .where(and(eq(events.id, eventId), isNull(events.wantsNoticeAt)))
    .returning({ id: events.id });
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// "want tue 14 rawai" — the same want, typed instead of tapped.
// ---------------------------------------------------------------------------

const TODAY_WORDS = new Set(["today", "сегодня", "hoy"]);
const TOMORROW_WORDS = new Set(["tomorrow", "tmr", "завтра", "mañana", "manana"]);
const NOISE = new Set(["want", "wanted", "play", "to", "at", "on", "in", "near", "around", "the", "a", "хочу", "играть", "в", "у", "около", "к", "quiero", "jugar", "en", "cerca", "sobre", "para"]);
/** An hour either side of a single time: "around two" is not "at 14:00 exactly". */
const AROUND_MS = 3600_000;

const clockOf = (tok: string): string | null => {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(tok);
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
};
const shiftClock = (time: string, ms: number): string => {
  const mins = Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) + ms / 60_000;
  const clamped = Math.max(0, Math.min(23 * 60 + 59, mins));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
};

export type WantLine = { weekday: number | null; onDate: string | null; fromTime: string | null; toTime: string | null; place: string };

/**
 * A typed want. Deliberately forgiving about order and language, and deliberately dumb about place:
 * whatever is left after the day and the hour is the place, resolved against real venues and cities
 * afterwards. Guessing a venue from a half-typed word is how somebody ends up waiting at the wrong club.
 */
export function parseWantLine(text: string, todayStr: string): WantLine {
  const out: WantLine = { weekday: null, onDate: null, fromTime: null, toTime: null, place: "" };
  const words: string[] = [];
  for (const raw of text.trim().split(/\s+/).filter(Boolean)) {
    const tok = raw.toLowerCase().replace(/[.,!?]+$/u, "");
    if (!tok || NOISE.has(tok)) continue;
    const range = /^(\d{1,2}(?::\d{2})?)\s*[-–]\s*(\d{1,2}(?::\d{2})?)$/.exec(tok);
    if (range) {
      const a = clockOf(range[1]);
      const b = clockOf(range[2]);
      if (a && b) {
        out.fromTime = a;
        out.toTime = b;
        continue;
      }
    }
    if (TODAY_WORDS.has(tok)) {
      out.onDate = todayStr;
      continue;
    }
    if (TOMORROW_WORDS.has(tok)) {
      out.onDate = new Date(new Date(`${todayStr}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10);
      continue;
    }
    if (tok in WEEKDAY_WORDS) {
      out.weekday = WEEKDAY_WORDS[tok];
      continue;
    }
    const dmy = /^(\d{1,2})[./](\d{1,2})$/.exec(tok);
    if (dmy) {
      const year = todayStr.slice(0, 4);
      const candidate = `${year}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
      // A day already gone this year means next year's, which is what "12.01" in December means.
      out.onDate = candidate < todayStr ? `${Number(year) + 1}-${candidate.slice(5)}` : candidate;
      continue;
    }
    const clock = clockOf(tok);
    if (clock && out.fromTime === null) {
      out.fromTime = shiftClock(clock, -AROUND_MS);
      out.toTime = shiftClock(clock, AROUND_MS);
      continue;
    }
    words.push(raw);
  }
  if (out.onDate) out.weekday = null;
  out.place = words.join(" ").trim();
  return out;
}

/**
 * The place, as a court or a city.
 *
 * A club Kicksmash lists is a real place before anybody has played there, and it is named rather
 * than slugged: somebody who says "WAREHAUS.club" means the club at `warehaus`, and slugifying what
 * they typed would make `warehaus-club`, which nothing answers to. The first match at a listed club
 * lands on its slug, so this want is waiting when it does.
 *
 * Otherwise a venue only counts when a match has actually been played there: a want pointed at a
 * slug nobody uses is a want that can never be answered.
 */
export async function resolvePlace(db: Db, text: string, fallbackVenue?: string | null): Promise<{ venueSlug: string | null; citySlug: string | null } | null> {
  const club = (await listedClub(db, text)) ?? (await listedClub(db, fallbackVenue));
  if (club) return { venueSlug: club.slug, citySlug: club.city ?? (club.tz ? (cityOf(club.tz, club.slug)?.slug ?? null) : null) };
  const slug = slugOf(text) ?? slugOf(fallbackVenue ?? "");
  if (slug) {
    const [hit] = await db.select({ slug: events.venueSlug, tz: events.tz }).from(events).where(eq(events.venueSlug, slug)).limit(1);
    if (hit?.slug) return { venueSlug: hit.slug, citySlug: cityOf(hit.tz, hit.slug)?.slug ?? null };
  }
  const city = cityInText(text);
  if (city) return { venueSlug: null, citySlug: city.slug };
  return null;
}

/** The shape a screen or a chat needs to describe a want; the row itself carries more than either uses. */
export type DemandSignalView = Pick<DemandSignal, "id" | "weekday" | "onDate" | "fromTime" | "toTime" | "venueSlug" | "citySlug">;
