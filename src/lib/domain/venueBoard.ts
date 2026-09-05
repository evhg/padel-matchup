import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, slots, type Event } from "@/db/schema";

/** "Padel Indoor BCN" → "padel-indoor-bcn". ASCII only on purpose: it is a URL and a QR target. */
export function venueSlug(name: string | null | undefined): string | null {
  const s = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s ? s.slice(0, 80) : null;
}

export const isValidVenueSlug = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 80;

export type BoardEvent = { event: Event; occupied: number; spotsLeft: number };
export type VenueBoard = { slug: string; name: string; mapUrl: string | null; events: BoardEvent[] };

/** Upcoming, not cancelled, organizer-listed matches at a venue. Null when the venue has never been used. */
export async function getVenueBoard(db: Db, slug: string, now = new Date()): Promise<VenueBoard | null> {
  const [latest] = await db.select({ venueName: events.venueName, venueMapUrl: events.venueMapUrl }).from(events).where(eq(events.venueSlug, slug)).orderBy(sql`${events.createdAt} desc`).limit(1);
  if (!latest?.venueName) return null;
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.venueSlug, slug), eq(events.publicListing, true), gt(events.startsAt, now), inArray(events.status, ["open", "full"])))
    .orderBy(asc(events.startsAt))
    .limit(40);
  if (rows.length === 0) return { slug, name: latest.venueName, mapUrl: latest.venueMapUrl, events: [] };
  const ids = rows.map((e) => e.id);
  const counts = await db
    .select({ eventId: slots.eventId, n: sql<number>`count(*)` })
    .from(slots)
    .where(and(inArray(slots.eventId, ids), inArray(slots.status, ["joined", "confirmed"]), sql`${slots.position} <= (select capacity from ${events} e where e.id = ${slots.eventId})`))
    .groupBy(slots.eventId);
  const open = await db
    .select({ eventId: slots.eventId, n: sql<number>`count(*)` })
    .from(slots)
    .where(and(inArray(slots.eventId, ids), inArray(slots.status, ["empty", "declined"]), sql`${slots.position} <= (select capacity from ${events} e where e.id = ${slots.eventId})`))
    .groupBy(slots.eventId);
  const occ = new Map(counts.map((c) => [c.eventId, Number(c.n)]));
  const free = new Map(open.map((c) => [c.eventId, Number(c.n)]));
  return { slug, name: latest.venueName, mapUrl: latest.venueMapUrl, events: rows.map((event) => ({ event, occupied: occ.get(event.id) ?? 0, spotsLeft: free.get(event.id) ?? 0 })) };
}

export async function setPublicListing(db: Db, eventId: string, on: boolean): Promise<Event> {
  const [ev] = await db.update(events).set({ publicListing: on }).where(eq(events.id, eventId)).returning();
  return ev;
}
