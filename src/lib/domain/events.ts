import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, events, series, slots, venues, type Event, type Slot, type TournamentFormat } from "@/db/schema";
import { newManageCode, newShareCode } from "@/lib/codes";
import { MATCH_CAPACITY, MAX_TOURNAMENT_CAPACITY } from "@/lib/config";
import { isValidTimeZone } from "@/lib/dates";
import { DomainError } from "./errors";
import { cleanAgeMin, cleanCategory, type EventCategory } from "./eventTags";
import { formatOf } from "./formats";
import { hasRange, normalizeRange } from "./levels";
import { defaultLength, parseMatchLength, type MatchLength } from "./matchLength";
import { venueSlugFor } from "./venueBoard";

export type CreateEventInput = {
  creatorPlayerId: string;
  type: "match" | "tournament";
  title?: string | null;
  startsAt: Date;
  /** 60, 90 or 120 minutes (`MATCH_LENGTHS`); omitted means 90 for a match, 120 for a tournament. Anything else is refused. */
  durationMinutes?: number | null;
  tz: string;
  /** Optional: empty means "court TBD". */
  venueName?: string | null;
  venueMapUrl?: string | null;
  court?: string | null;
  capacity?: number;
  whenFull: "waitlist" | "closed";
  note?: string | null;
  courts?: number | null;
  pointsPerMatch?: number | null;
  /** First to N games instead of points. */
  gamesTo?: number | null;
  /** Tournament format; omitted = americano. */
  format?: TournamentFormat | null;
  /** Level range; omitted or 0–7 = open to everyone. */
  levelMin?: number | null;
  levelMax?: number | null;
  /** Verified levels only: inside the range but unconfirmed still asks to join. Ignored without a range. */
  levelVerifiedOnly?: boolean;
  /** Who it is for (`eventTags.ts`): men, women or mixed, and 35, 45 or 55. Anything else is stored as none; nothing is checked at join. */
  category?: EventCategory | null;
  ageMin?: number | null;
  /** The group this match belongs to. */
  groupId?: string | null;
  /** Opt-in to the public venue board. */
  publicListing?: boolean;
  /** Link to the club's booking page or confirmation. */
  bookingUrl?: string | null;
  /** What each player pays and how to pay the organizer; free text. */
  cost?: string | null;
  payNote?: string | null;
};

export function cleanText(v: string | null | undefined, max: number): string | null {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function cleanUrl(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString().slice(0, 500);
  } catch {
    return null;
  }
}

/** The length a write stores: one of the three, the type's default when nobody said, and a refusal for anything else. */
export function resolveLength(type: "match" | "tournament", minutes?: number | null): MatchLength {
  if (minutes === undefined || minutes === null) return defaultLength(type);
  const m = parseMatchLength(minutes);
  if (!m) throw new DomainError("invalid", "durationMinutes");
  return m;
}

export function resolveCapacity(type: "match" | "tournament", capacity?: number): number {
  if (type === "match") return MATCH_CAPACITY;
  // Americano runs in fours (one court per 4). 4..64; round 1 later shrinks it to the players present.
  const c = Math.round(Number(capacity ?? 8));
  if (!Number.isFinite(c) || c < 4 || c > MAX_TOURNAMENT_CAPACITY || c % 4 !== 0) throw new DomainError("invalid", "capacity");
  return c;
}

/**
 * A tournament's field rounded up to fours, for whatever copies one. Round 1 shrinks the capacity to
 * the names present, and since americano and mexicano rest whoever does not fit a court, that can be
 * ten. "Play again", a group's weekly match and a series' next edition then offer twelve, which
 * `resolveCapacity` accepts and round 1 shrinks again.
 */
export const fieldInFours = (capacity: number): number => Math.min(MAX_TOURNAMENT_CAPACITY, Math.max(4, Math.ceil(capacity / 4) * 4));

/** Persists the creator's venue memory (upsert by name) and touches last_used_at. */
export async function rememberVenue(db: Db, creatorPlayerId: string, name: string, mapUrl: string | null) {
  await db
    .insert(venues)
    .values({ creatorPlayerId, name, mapUrl, lastUsedAt: new Date() })
    .onConflictDoUpdate({
      target: [venues.creatorPlayerId, venues.name],
      set: { lastUsedAt: new Date(), mapUrl: mapUrl ?? sql`${venues.mapUrl}` },
    });
}

export async function createEvent(db: Db, input: CreateEventInput): Promise<Event> {
  const venueName = cleanText(input.venueName, 80);
  if (!isValidTimeZone(input.tz)) throw new DomainError("invalid", "tz");
  if (!(input.startsAt instanceof Date) || Number.isNaN(input.startsAt.getTime())) throw new DomainError("invalid", "startsAt");
  const capacity = resolveCapacity(input.type, input.capacity);
  const durationMinutes = resolveLength(input.type, input.durationMinutes);
  const venueMapUrl = cleanUrl(input.venueMapUrl);
  const range = normalizeRange(input.levelMin, input.levelMax);
  // "WAREHAUS.club" is the club at `warehaus`, whatever its name would make of itself. Asked before
  // the transaction opens, so the write stays one statement.
  const slug = await venueSlugFor(db, venueName);

  return db.transaction(async (tx) => {
    let event: Event | undefined;
    // Retry on the (rare) 4-char code collision.
    for (let attempt = 0; attempt < 6 && !event; attempt++) {
      const code = newShareCode();
      const [existing] = await tx.select({ id: events.id }).from(events).where(eq(events.code, code)).limit(1);
      if (existing) continue;
      [event] = await tx
        .insert(events)
        .values({
          code,
          type: input.type,
          title: cleanText(input.title, 80),
          startsAt: input.startsAt,
          durationMinutes,
          tz: input.tz,
          venueName,
          venueMapUrl,
          court: cleanText(input.court, 40),
          capacity,
          whenFull: input.whenFull === "closed" ? "closed" : "waitlist",
          note: cleanText(input.note, 500),
          creatorPlayerId: input.creatorPlayerId,
          manageCode: newManageCode(),
          status: "open",
          format: input.type === "tournament" ? formatOf(input.format) : null,
          courts: input.type === "tournament" && input.courts ? Math.max(1, Math.min(16, Math.round(input.courts))) : null,
          pointsPerMatch: input.type === "tournament" && input.pointsPerMatch && !input.gamesTo ? Math.max(4, Math.min(99, Math.round(input.pointsPerMatch))) : null,
          gamesTo: input.type === "tournament" && input.gamesTo ? Math.max(2, Math.min(12, Math.round(input.gamesTo))) : null,
          levelMin: range.min,
          levelMax: range.max,
          levelVerifiedOnly: Boolean(input.levelVerifiedOnly) && hasRange(range),
          category: cleanCategory(input.category),
          ageMin: cleanAgeMin(input.ageMin),
          groupId: input.groupId ?? null,
          publicListing: Boolean(input.publicListing) && Boolean(venueName),
          venueSlug: slug,
          bookingUrl: cleanUrl(input.bookingUrl),
          cost: cleanText(input.cost, 40),
          payNote: cleanText(input.payNote, 120),
        })
        .returning();
    }
    if (!event) throw new Error("Could not allocate a share code");

    await tx.insert(slots).values(
      Array.from({ length: capacity }, (_, i) => ({
        eventId: event!.id,
        position: i + 1,
        kind: "open" as const,
        status: "empty" as const,
      })),
    );
    await tx.insert(activity).values({ eventId: event.id, actorPlayerId: input.creatorPlayerId, verb: "created" });
    if (venueName) await rememberVenue(tx, input.creatorPlayerId, venueName, venueMapUrl);
    return event;
  });
}

/** Next occurrence of the same weekday/time strictly after `now`. */
export function nextWeekAfter(startsAt: Date, now = new Date()): Date {
  const week = 7 * 24 * 3600 * 1000;
  let t = startsAt.getTime() + week;
  while (t <= now.getTime()) t += week;
  return new Date(t);
}

/** "Play again": clone an event one week later with the same settings; the organizer joins automatically. */
export async function duplicateEvent(db: Db, input: { sourceEventId: string; creatorPlayerId: string; now?: Date }): Promise<Event> {
  const now = input.now ?? new Date();
  const [src] = await db.select().from(events).where(eq(events.id, input.sourceEventId)).limit(1);
  if (!src) throw new DomainError("not_found");
  return createEvent(db, {
    creatorPlayerId: input.creatorPlayerId,
    type: src.type,
    title: src.title,
    startsAt: nextWeekAfter(src.startsAt, now),
    // "Play again" books the same court for the same time: the length travels with the rest.
    durationMinutes: src.durationMinutes,
    tz: src.tz,
    venueName: src.venueName,
    venueMapUrl: src.venueMapUrl,
    court: src.court,
    capacity: src.type === "tournament" ? fieldInFours(src.capacity) : src.capacity,
    whenFull: src.whenFull,
    note: src.note,
    courts: src.courts,
    pointsPerMatch: src.pointsPerMatch,
    gamesTo: src.gamesTo,
    format: src.format,
    levelMin: src.levelMin,
    levelMax: src.levelMax,
    levelVerifiedOnly: src.levelVerifiedOnly,
    // A ladies' match played again is a ladies' match.
    category: src.category,
    ageMin: src.ageMin,
    groupId: src.groupId,
    publicListing: src.publicListing,
    bookingUrl: src.bookingUrl,
    cost: src.cost,
    payNote: src.payNote,
  });
}

export type UpdateEventInput = {
  title?: string | null;
  startsAt?: Date;
  /** 60, 90 or 120; anything else is refused. A change moves the calendar entry's end, as a new time does. */
  durationMinutes?: number;
  tz?: string;
  venueName?: string | null;
  venueMapUrl?: string | null;
  court?: string | null;
  note?: string | null;
  whenFull?: "waitlist" | "closed";
  capacity?: number;
  levelMin?: number | null;
  levelMax?: number | null;
  levelVerifiedOnly?: boolean;
  /** Undefined leaves the tag alone; null takes it off. */
  category?: EventCategory | null;
  ageMin?: number | null;
  publicListing?: boolean;
  bookingUrl?: string | null;
  cost?: string | null;
  payNote?: string | null;
};

export type UpdateEventResult = {
  event: Event;
  /** True when the time, the length or the venue changed → send updated .ics to participants. */
  calendarChanged: boolean;
  /** Waitlisted players who became roster members because capacity grew. */
  promotedPlayerIds: string[];
};

export async function updateEvent(db: Db, eventId: string, actorPlayerId: string | null, patch: UpdateEventInput): Promise<UpdateEventResult> {
  // Asked before the transaction opens. Inside one, this query waits on a connection the transaction
  // is already holding, and the whole call hangs until it times out.
  const venueName = patch.venueName === undefined ? undefined : cleanText(patch.venueName, 80);
  const movedSlug = venueName === undefined ? null : await venueSlugFor(db, venueName);
  return db.transaction(async (tx) => {
    const [ev] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
    if (!ev) throw new DomainError("not_found");
    if (ev.status === "cancelled") throw new DomainError("cancelled");

    const set: Partial<typeof events.$inferInsert> = {};
    let calendarChanged = false;

    if (patch.title !== undefined) set.title = cleanText(patch.title, 80);
    if (patch.note !== undefined) set.note = cleanText(patch.note, 500);
    if (patch.whenFull !== undefined) set.whenFull = patch.whenFull === "closed" ? "closed" : "waitlist";
    if (patch.levelMin !== undefined || patch.levelMax !== undefined) {
      const r = normalizeRange(patch.levelMin !== undefined ? patch.levelMin : ev.levelMin, patch.levelMax !== undefined ? patch.levelMax : ev.levelMax);
      if (r.min !== ev.levelMin) set.levelMin = r.min;
      if (r.max !== ev.levelMax) set.levelMax = r.max;
    }
    if (patch.levelVerifiedOnly !== undefined || patch.levelMin !== undefined || patch.levelMax !== undefined) {
      const after = { min: "levelMin" in set ? (set.levelMin ?? null) : ev.levelMin, max: "levelMax" in set ? (set.levelMax ?? null) : ev.levelMax };
      const want = (patch.levelVerifiedOnly ?? ev.levelVerifiedOnly) && hasRange(after);
      if (want !== ev.levelVerifiedOnly) set.levelVerifiedOnly = want;
    }
    // Information, not a rule: a new tag reaches the page and the cards, and no calendar.
    if (patch.category !== undefined) {
      const c = cleanCategory(patch.category);
      if (c !== ev.category) set.category = c;
    }
    if (patch.ageMin !== undefined) {
      const a = cleanAgeMin(patch.ageMin);
      if (a !== ev.ageMin) set.ageMin = a;
    }
    if (patch.tz !== undefined) {
      if (!isValidTimeZone(patch.tz)) throw new DomainError("invalid", "tz");
      set.tz = patch.tz;
    }
    if (patch.startsAt !== undefined) {
      if (Number.isNaN(patch.startsAt.getTime())) throw new DomainError("invalid", "startsAt");
      if (patch.startsAt.getTime() !== ev.startsAt.getTime()) {
        set.startsAt = patch.startsAt;
        calendarChanged = true;
        // Re-opening a finished event by moving it into the future.
        if (ev.status === "past") set.status = "open";
      }
    }
    if (patch.durationMinutes !== undefined) {
      const minutes = parseMatchLength(patch.durationMinutes);
      if (!minutes) throw new DomainError("invalid", "durationMinutes");
      // A new length is a new end: the players' calendars hold the old one, so it goes out as a time change does.
      if (minutes !== ev.durationMinutes) {
        set.durationMinutes = minutes;
        calendarChanged = true;
      }
    }
    if (venueName !== undefined) {
      if (venueName !== ev.venueName) {
        set.venueName = venueName;
        set.venueSlug = movedSlug;
        if (!venueName) set.publicListing = false;
        calendarChanged = true;
      }
    }
    if (patch.bookingUrl !== undefined) {
      const u = cleanUrl(patch.bookingUrl);
      if (u !== ev.bookingUrl) set.bookingUrl = u;
    }
    if (patch.cost !== undefined) {
      const c = cleanText(patch.cost, 40);
      if (c !== ev.cost) set.cost = c;
    }
    if (patch.payNote !== undefined) {
      const c = cleanText(patch.payNote, 120);
      if (c !== ev.payNote) set.payNote = c;
    }
    if (patch.publicListing !== undefined) {
      const venueAfter = set.venueName !== undefined ? set.venueName : ev.venueName;
      set.publicListing = Boolean(patch.publicListing) && Boolean(venueAfter);
    }
    if (patch.court !== undefined) {
      const c = cleanText(patch.court, 40);
      if (c !== ev.court) {
        set.court = c;
        calendarChanged = true;
      }
    }
    if (patch.venueMapUrl !== undefined) {
      const u = cleanUrl(patch.venueMapUrl);
      if (u !== ev.venueMapUrl) {
        set.venueMapUrl = u;
        calendarChanged = calendarChanged || Boolean(u);
      }
    }

    const promotedPlayerIds: string[] = [];
    // An unchanged capacity is no change, even one round 1 left outside fours (ten players).
    if (patch.capacity !== undefined && ev.type === "tournament" && patch.capacity !== ev.capacity) {
      const newCap = resolveCapacity("tournament", patch.capacity);
      if (newCap > ev.capacity) {
        const existing = await tx
          .select({ position: slots.position, playerId: slots.playerId, status: slots.status })
          .from(slots)
          .where(and(eq(slots.eventId, ev.id), gt(slots.position, ev.capacity)));
        const taken = new Set(existing.map((s) => s.position));
        const toInsert = [];
        for (let p = ev.capacity + 1; p <= newCap; p++) {
          if (!taken.has(p)) toInsert.push({ eventId: ev.id, position: p, kind: "open" as const, status: "empty" as const });
        }
        if (toInsert.length) await tx.insert(slots).values(toInsert);
        for (const s of existing) {
          if (s.position <= newCap && s.playerId && s.status === "joined") promotedPlayerIds.push(s.playerId);
        }
        set.capacity = newCap;
      } else if (newCap < ev.capacity) {
        const trailing = await tx
          .select()
          .from(slots)
          .where(and(eq(slots.eventId, ev.id), gt(slots.position, newCap)));
        const roster = trailing.filter((s) => s.position <= ev.capacity);
        if (roster.some((s) => s.status !== "empty" && s.status !== "declined")) throw new DomainError("invalid", "capacity_in_use");
        if (roster.length) {
          await tx.delete(slots).where(
            inArray(
              slots.id,
              roster.map((s) => s.id),
            ),
          );
        }
        set.capacity = newCap;
      }
    }

    if (calendarChanged) set.icsSequence = ev.icsSequence + 1;
    if (Object.keys(set).length === 0) return { event: ev, calendarChanged: false, promotedPlayerIds };

    const [updated] = await tx.update(events).set(set).where(eq(events.id, ev.id)).returning();
    // An edition is made from its series row, so a tag the series' organiser sets here would be gone by
    // the next edition. Their change is the series' change too; a player who edits the edition changes
    // this date only. One update by primary key, and only when the tag moved.
    if (ev.seriesId && actorPlayerId && ("category" in set || "ageMin" in set)) {
      await tx
        .update(series)
        .set({ category: updated.category, ageMin: updated.ageMin, updatedAt: new Date() })
        .where(and(eq(series.id, ev.seriesId), eq(series.organizerPlayerId, actorPlayerId)));
    }
    for (const pid of promotedPlayerIds) {
      await tx.insert(activity).values({ eventId: ev.id, actorPlayerId: pid, verb: "promoted" });
    }
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId, verb: "updated" });
    if ((set.venueName || set.venueMapUrl !== undefined) && updated.venueName) {
      await rememberVenue(tx, ev.creatorPlayerId, updated.venueName, updated.venueMapUrl);
    }
    await recomputeStatus(tx, updated);
    const [fresh] = await tx.select().from(events).where(eq(events.id, ev.id));
    return { event: fresh, calendarChanged, promotedPlayerIds };
  });
}

export async function cancelEvent(db: Db, eventId: string, actorPlayerId: string | null): Promise<Event> {
  return db.transaction(async (tx) => {
    const [ev] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
    if (!ev) throw new DomainError("not_found");
    if (ev.status === "cancelled") return ev;
    const [updated] = await tx
      .update(events)
      .set({ status: "cancelled", icsSequence: ev.icsSequence + 1 })
      .where(eq(events.id, ev.id))
      .returning();
    await tx.insert(activity).values({ eventId: ev.id, actorPlayerId, verb: "cancelled" });
    return updated;
  });
}

/** Roster = positions 1..capacity. A roster slot is claimable when empty or declined. */
export const isRosterSlot = (slot: Pick<Slot, "position">, capacity: number) => slot.position <= capacity;
export const isClaimable = (slot: Pick<Slot, "status">) => slot.status === "empty" || slot.status === "declined";
export const isOccupied = (slot: Pick<Slot, "status">) => slot.status === "joined" || slot.status === "confirmed";
/** Does this player hold a real seat on the roster (joined or confirmed)? The waitlist is not a seat. */
export const isSeated = (detail: { roster: Pick<Slot, "status" | "playerId">[] }, playerId: string | null | undefined): boolean => Boolean(playerId) && detail.roster.some((s) => s.playerId === playerId && isOccupied(s));

/**
 * Who may change a match's details (time, length, place, court, note, price): the organiser, and
 * every player who holds a seat in it. The owner, 9 October 2026: "any player should be able to
 * change match details" - this is a friendly app among people who play together, and the one who
 * books the court is often not the one who made the match. Cancelling the match, removing people
 * and the organiser's own switches stay with the organiser.
 */
export const canEditMatchDetails = (detail: { roster: Pick<Slot, "status" | "playerId">[] }, viewer: { isCreator: boolean; playerId: string | null | undefined }): boolean =>
  viewer.isCreator || isSeated(detail, viewer.playerId);

/**
 * open ↔ full is derived from roster occupancy. cancelled/past are terminal
 * and never overwritten here.
 */
export async function recomputeStatus(tx: Db, ev: Pick<Event, "id" | "capacity" | "status">): Promise<Event["status"]> {
  if (ev.status === "cancelled" || ev.status === "past") return ev.status;
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(slots)
    .where(and(eq(slots.eventId, ev.id), sql`${slots.position} <= ${ev.capacity}`, inArray(slots.status, ["empty", "declined"])));
  const next: Event["status"] = Number(n) > 0 ? "open" : "full";
  if (next !== ev.status) await tx.update(events).set({ status: next }).where(eq(events.id, ev.id));
  return next;
}
