import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { eventPhotos, events, slots, type EventPhoto } from "@/db/schema";
import { DomainError } from "@/lib/domain/errors";

/**
 * The court photo. Any participant adds it once the match has started; the result card
 * becomes that photo with the score as a quiet layer. Kept small (the browser downsizes
 * before upload), one per match, replaceable by whoever added it or the organiser.
 */

export const PHOTO_MAX_BYTES = 900_000;

export async function setEventPhoto(db: Db, input: { eventId: string; playerId: string; mime: string; dataBase64: string }, now = new Date()): Promise<EventPhoto> {
  if (!/^image\/(jpeg|png|webp)$/.test(input.mime)) throw new DomainError("invalid", "mime");
  const clean = input.dataBase64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(clean) || Buffer.from(clean, "base64").length > PHOTO_MAX_BYTES) throw new DomainError("invalid", "size");
  const [ev] = await db.select().from(events).where(eq(events.id, input.eventId)).limit(1);
  if (!ev) throw new DomainError("not_found");
  if (ev.startsAt.getTime() > now.getTime()) throw new DomainError("not_started");
  const [seat] = await db.select({ id: slots.id }).from(slots).where(and(eq(slots.eventId, ev.id), eq(slots.playerId, input.playerId), inArray(slots.status, ["joined", "confirmed"]))).limit(1);
  if (!seat && ev.creatorPlayerId !== input.playerId) throw new DomainError("forbidden");
  const [row] = await db
    .insert(eventPhotos)
    .values({ eventId: ev.id, uploadedByPlayerId: input.playerId, mime: input.mime, dataBase64: clean, createdAt: now })
    .onConflictDoUpdate({ target: eventPhotos.eventId, set: { uploadedByPlayerId: input.playerId, mime: input.mime, dataBase64: clean, createdAt: now } })
    .returning();
  return row;
}

export async function removeEventPhoto(db: Db, eventId: string, playerId: string): Promise<void> {
  const [ev] = await db.select({ creatorPlayerId: events.creatorPlayerId }).from(events).where(eq(events.id, eventId)).limit(1);
  const [photo] = await db.select().from(eventPhotos).where(eq(eventPhotos.eventId, eventId)).limit(1);
  if (!ev || !photo) return;
  if (photo.uploadedByPlayerId !== playerId && ev.creatorPlayerId !== playerId) throw new DomainError("forbidden");
  await db.delete(eventPhotos).where(eq(eventPhotos.eventId, eventId));
}

export async function getEventPhoto(db: Db, eventId: string): Promise<EventPhoto | null> {
  const [row] = await db.select().from(eventPhotos).where(eq(eventPhotos.eventId, eventId)).limit(1);
  return row ?? null;
}

export const photoDataUrl = (p: Pick<EventPhoto, "mime" | "dataBase64">) => `data:${p.mime};base64,${p.dataBase64}`;
