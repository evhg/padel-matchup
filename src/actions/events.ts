"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { zonedTimeToUtc } from "@/lib/dates";
import { cancelEvent, createEvent, duplicateEvent, updateEvent } from "@/lib/domain/events";
import { normalizeEmail, updatePlayer } from "@/lib/domain/players";
import { notifyEventCancelled, notifyEventUpdated, notifyPromotion, welcomeEmail } from "@/lib/notify";
import { ActionFailure, getViewer, loadEvent, requireCreator, requirePlayer, runA, type ActionResult } from "./shared";

const createSchema = z.object({
  name: z.string().optional(),
  type: z.enum(["match", "tournament"]),
  title: z.string().max(80).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  tz: z.string().min(1).max(64),
  venueName: z.string().max(80).optional(),
  venueMapUrl: z.string().max(500).optional(),
  court: z.string().max(40).optional(),
  note: z.string().max(500).optional(),
  capacity: z.coerce.number().int().min(4).max(64).multipleOf(4).optional(),
  whenFull: z.enum(["waitlist", "closed"]),
  courts: z.coerce.number().int().min(1).max(16).nullable().optional(),
  pointsPerMatch: z.coerce.number().int().min(4).max(99).nullable().optional(),
  joinSelf: z.boolean().optional(),
});
export type CreateEventInput = z.infer<typeof createSchema>;

export async function createEventAction(raw: CreateEventInput): Promise<ActionResult<{ code: string }>> {
  let code: string | null = null;
  const res = await runA(async () => {
    const input = createSchema.parse(raw);
    const db = await getDb();
    const me = await requirePlayer(db, input.name);
    const startsAt = zonedTimeToUtc(input.date, input.time, input.tz);
    if (Number.isNaN(startsAt.getTime())) throw new ActionFailure("invalid");
    const ev = await createEvent(db, {
      creatorPlayerId: me.id,
      type: input.type,
      title: input.title,
      startsAt,
      tz: input.tz,
      venueName: input.venueName,
      venueMapUrl: input.venueMapUrl,
      court: input.court,
      capacity: input.capacity,
      whenFull: input.whenFull,
      note: input.note,
      courts: input.courts ?? null,
      pointsPerMatch: input.pointsPerMatch ?? null,
    });
    if (input.joinSelf !== false) {
      // Organizers play too. Skip silently if the match was logged after the fact.
      const { joinEvent } = await import("@/lib/domain/slots");
      await joinEvent(db, { eventId: ev.id, playerId: me.id }).catch(() => undefined);
    }
    code = ev.code;
    return { code: ev.code };
  });
  if (res.ok && code) redirect(`/${code}/share`);
  return res;
}

const updateSchema = z.object({
  title: z.string().max(80).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  tz: z.string().min(1).max(64).optional(),
  venueName: z.string().max(80).optional(),
  venueMapUrl: z.string().max(500).optional(),
  court: z.string().max(40).optional(),
  note: z.string().max(500).optional(),
  capacity: z.coerce.number().int().min(4).max(64).multipleOf(4).optional(),
  whenFull: z.enum(["waitlist", "closed"]).optional(),
});
export type UpdateEventInput = z.infer<typeof updateSchema>;

/** "Play again": any participant or the organizer clones this event one week later and becomes its organizer. */
export async function duplicateEventAction(code: string): Promise<ActionResult<{ code: string }>> {
  let newCode: string | null = null;
  const res = await runA(async () => {
    const { db, detail } = await loadEvent(code);
    const viewer = await getViewer(db, detail);
    const isParticipant = Boolean(viewer.player && detail.roster.some((s) => s.playerId === viewer.player!.id && (s.status === "joined" || s.status === "confirmed")));
    if (!viewer.isCreator && !isParticipant) throw new ActionFailure("forbidden");
    const creatorId = viewer.player?.id ?? detail.event.creatorPlayerId;
    const ev = await duplicateEvent(db, { sourceEventId: detail.event.id, creatorPlayerId: creatorId });
    const { joinEvent } = await import("@/lib/domain/slots");
    await joinEvent(db, { eventId: ev.id, playerId: creatorId }).catch(() => undefined);
    newCode = ev.code;
    return { code: ev.code };
  });
  if (res.ok && newCode) redirect(`/${newCode}/share`);
  return res;
}

export async function updateEventAction(code: string, raw: UpdateEventInput): Promise<ActionResult<null>> {
  return runA(async () => {
    const input = updateSchema.parse(raw);
    const { db, detail, viewer } = await requireCreator(code);
    const tz = input.tz ?? detail.event.tz;
    const startsAt = input.date && input.time ? zonedTimeToUtc(input.date, input.time, tz) : undefined;
    const result = await updateEvent(db, detail.event.id, viewer.player?.id ?? null, {
      title: input.title,
      startsAt,
      tz: input.tz,
      venueName: input.venueName,
      venueMapUrl: input.venueMapUrl,
      court: input.court,
      note: input.note,
      whenFull: input.whenFull,
      capacity: input.capacity,
    });
    if (result.calendarChanged) after(() => notifyEventUpdated(db, result.event));
    for (const pid of result.promotedPlayerIds) {
      after(() => notifyPromotion(db, result.event, { playerId: pid, slot: null as never }));
    }
    revalidatePath(`/${code}`);
    return null;
  });
}

export async function cancelEventAction(code: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    const ev = await cancelEvent(db, detail.event.id, viewer.player?.id ?? null);
    after(() => notifyEventCancelled(db, ev));
    revalidatePath(`/${code}`);
    return null;
  });
}

/** Share screen: "your email for notifications" (creator). */
export async function setCreatorEmailAction(code: string, email: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    const target = viewer.player?.id === detail.event.creatorPlayerId ? viewer.player.id : detail.event.creatorPlayerId;
    const normalized = normalizeEmail(email);
    const updated = await updatePlayer(db, target, { email: normalized });
    if (updated && normalized && normalized !== detail.creator.email) after(() => welcomeEmail(db, updated, detail.event));
    revalidatePath(`/${code}`);
    return null;
  });
}
