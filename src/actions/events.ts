"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { players } from "@/db/schema";
import { zonedTimeToUtc } from "@/lib/dates";
import { cancelEvent, createEvent, duplicateEvent, updateEvent } from "@/lib/domain/events";
import { getGroupByCode, getGroupMember } from "@/lib/domain/groups";
import { changePlayerEmail } from "@/lib/domain/identity";
import { normalizeEmail } from "@/lib/domain/players";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { notifyEventCancelled, notifyEventUpdated, notifyGroupMatch, notifyPromotion, welcomeEmail } from "@/lib/notify";
import { ActionFailure, assertRate, getViewer, loadEvent, requireCreator, requirePlayer, runA, type ActionResult } from "./shared";
import { LIMITS } from "@/lib/domain/ratelimit";

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
  levelMin: z.coerce.number().min(0).max(7).nullable().optional(),
  levelMax: z.coerce.number().min(0).max(7).nullable().optional(),
  myLevel: z.coerce.number().min(0).max(7).nullable().optional(),
  /** Created from a group page: the match belongs to the group and every member is notified. */
  groupCode: z.string().length(6).optional(),
  publicListing: z.boolean().optional(),
  bookingUrl: z.string().max(500).optional(),
});
export type CreateEventInput = z.infer<typeof createSchema>;

export async function createEventAction(raw: CreateEventInput): Promise<ActionResult<{ code: string }>> {
  let code: string | null = null;
  const res = await runA(async () => {
    const input = createSchema.parse(raw);
    const db = await getDb();
    const me = await requirePlayer(db, input.name);
    await assertRate(db, "create", me.id, LIMITS.eventsPerPlayerPerDay);
    const startsAt = zonedTimeToUtc(input.date, input.time, input.tz);
    if (Number.isNaN(startsAt.getTime())) throw new ActionFailure("invalid");
    const group = input.groupCode ? await getGroupByCode(db, input.groupCode) : null;
    if (input.groupCode && !group) throw new ActionFailure("not_found");
    if (group && !(await getGroupMember(db, group.id, me.id))) throw new ActionFailure("forbidden");
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
      levelMin: input.levelMin ?? null,
      levelMax: input.levelMax ?? null,
      groupId: group?.id ?? null,
      publicListing: input.publicListing ?? false,
      bookingUrl: input.bookingUrl,
    });
    after(async () => {
      await emitMatchEvent(db, "match.created", ev.code);
    });
    if (group) {
      after(async () => {
        await notifyGroupMatch(db, group, ev, me.id);
      });
    }
    if (input.myLevel != null && me.level == null) {
      const { setPlayerLevel } = await import("@/lib/domain/rating");
      await setPlayerLevel(db, me.id, input.myLevel);
    }
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
  levelMin: z.coerce.number().min(0).max(7).nullable().optional(),
  levelMax: z.coerce.number().min(0).max(7).nullable().optional(),
  publicListing: z.boolean().optional(),
  bookingUrl: z.string().max(500).optional(),
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
    after(async () => {
      await emitMatchEvent(db, "match.created", ev.code, { playAgainOf: code });
    });
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
      levelMin: input.levelMin,
      levelMax: input.levelMax,
      publicListing: input.publicListing,
      bookingUrl: input.bookingUrl,
    });
    if (result.calendarChanged) after(() => notifyEventUpdated(db, result.event));
    after(async () => {
      await emitMatchEvent(db, "match.updated", code);
    });
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
    after(async () => {
      await emitMatchEvent(db, "match.cancelled", code);
    });
    revalidatePath(`/${code}`);
    return null;
  });
}

/** Share screen: "your email for notifications" (creator). */
export async function setCreatorEmailNotificationsAction(code: string, on: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await requireCreator(code);
    await db.update(players).set({ emailNotifications: Boolean(on) }).where(eq(players.id, detail.event.creatorPlayerId));
    revalidatePath(`/${code}`);
    return null;
  });
}

export async function setCreatorEmailAction(code: string, email: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    const target = viewer.player?.id === detail.event.creatorPlayerId ? viewer.player.id : detail.event.creatorPlayerId;
    const { player: updated, changed } = await changePlayerEmail(db, target, normalizeEmail(email));
    if (changed) after(() => welcomeEmail(db, updated, detail.event));
    revalidatePath(`/${code}`);
    return null;
  });
}
