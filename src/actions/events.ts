"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { players } from "@/db/schema";
import { isValidTimeZone, zonedTimeToUtc } from "@/lib/dates";
import { pasteBooking, type PasteResult } from "@/lib/booking/paste";
import { readScreenshot, type ShotResult } from "@/lib/booking/screenshot";
import { SHOT_MAX_BYTES } from "@/lib/domain/bookingShot";
import { PASTE_TEXT_MAX } from "@/lib/domain/bookingPaste";
import { clientKeyFrom } from "@/lib/ipKey";
import { getSessionPlayer } from "@/lib/session";
import { setBanter } from "@/lib/domain/banter";
import { cancelEvent, createEvent, isSeated, updateEvent } from "@/lib/domain/events";
import { getGroupByCode, getGroupMember } from "@/lib/domain/groups";
import { AGE_MINS, EVENT_CATEGORIES } from "@/lib/domain/eventTags";
import { MATCH_LENGTHS } from "@/lib/domain/matchLength";
import { changePlayerEmail } from "@/lib/domain/identity";
import { getPlayer, normalizeEmail } from "@/lib/domain/players";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { postCardForTicket } from "@/lib/telegram/bot";
import { postCardForDiscordTicket } from "@/lib/discord/bot";
import { notifyEventCancelled, notifyEventUpdated, notifyGroupMatch, notifyPlayAgain, notifyPromotion, sendCalendarInvite, welcomeEmail } from "@/lib/notify";
import { nextGameFor, playAgainStart } from "@/lib/domain/playAgain";
import { heldRecordsFor, pastPlayerRows, pastViews, pickable } from "@/lib/domain/heldRecord";
import { cleanPicks, type PastView } from "@/lib/domain/pastAsk";
import { ActionFailure, assertRate, getViewer, loadEvent, requireCreator, requireMatchEditor, requirePlayer, runA, type ActionResult } from "./shared";
import { LIMITS } from "@/lib/domain/ratelimit";

const createSchema = z.object({
  name: z.string().optional(),
  /** Players carried from the americano generator; seated as reserved spots on create. */
  names: z.array(z.string().max(60)).max(64).optional(),
  /**
   * The organiser's answers for held names: a chip from "Played with you", or "Yes, that's Danny" with
   * the day and the club it was shown. Held to their shape by `cleanPicks`; the record is found again
   * among the organiser's own past players (`heldRecordsFor`), and every other name is held by name.
   */
  picks: z.unknown().optional(),
  type: z.enum(["match", "tournament"]),
  title: z.string().max(80).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  /** 60, 90 or 120 minutes; omitted means the type's default. Three taps on the form, never a typed number. */
  durationMinutes: z.literal(MATCH_LENGTHS).optional(),
  tz: z.string().min(1).max(64),
  venueName: z.string().max(80).optional(),
  venueMapUrl: z.string().max(500).optional(),
  court: z.string().max(40).optional(),
  note: z.string().max(500).optional(),
  capacity: z.coerce.number().int().min(4).max(64).multipleOf(4).optional(),
  whenFull: z.enum(["waitlist", "closed"]),
  courts: z.coerce.number().int().min(1).max(16).nullable().optional(),
  pointsPerMatch: z.coerce.number().int().min(4).max(99).nullable().optional(),
  gamesTo: z.coerce.number().int().min(2).max(12).nullable().optional(),
  format: z.enum(["americano", "mexicano", "king"]).optional(),
  /** Tournament: two partners play every round together (decision F). */
  fixedPairs: z.boolean().optional(),
  joinSelf: z.boolean().optional(),
  levelMin: z.coerce.number().min(0).max(7).nullable().optional(),
  levelMax: z.coerce.number().min(0).max(7).nullable().optional(),
  levelVerifiedOnly: z.boolean().optional(),
  /** Who it is for: chips on the form, so anything else is a form that is not ours, and refused. */
  category: z.enum(EVENT_CATEGORIES).nullable().optional(),
  ageMin: z.literal(AGE_MINS).nullable().optional(),
  myLevel: z.coerce.number().min(0).max(7).nullable().optional(),
  /** Created from a group page: the match belongs to the group and every member is notified. */
  groupCode: z.string().length(6).optional(),
  publicListing: z.boolean().optional(),
  bookingUrl: z.string().max(500).optional(),
  cost: z.string().max(40).optional(),
  payNote: z.string().max(120).optional(),
  /** "Court booked by me": the organiser booked the court before making the match (a pasted booking). */
  booked: z.boolean().optional(),
  /** A pasted booking's invitation for strangers: kept only when `madeToShare` takes it (`createEvent`), never as sent. */
  invite: z.string().max(500).optional(),
  /** Signed chat ticket from the Telegram bot's /new. */
  telegramTicket: z.string().max(80).optional(),
  /** Signed channel ticket from the Discord bot's /new. */
  discordTicket: z.string().max(80).optional(),
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
      durationMinutes: input.durationMinutes,
      tz: input.tz,
      venueName: input.venueName,
      venueMapUrl: input.venueMapUrl,
      court: input.court,
      capacity: input.capacity,
      whenFull: input.whenFull,
      note: input.note,
      courts: input.courts ?? null,
      pointsPerMatch: input.pointsPerMatch ?? null,
      gamesTo: input.gamesTo ?? null,
      format: input.format ?? null,
      fixedPairs: input.fixedPairs ?? false,
      levelMin: input.levelMin ?? null,
      levelMax: input.levelMax ?? null,
      levelVerifiedOnly: input.levelVerifiedOnly ?? false,
      category: input.category ?? null,
      ageMin: input.ageMin ?? null,
      groupId: group?.id ?? null,
      publicListing: input.publicListing ?? false,
      bookingUrl: input.bookingUrl,
      invite: input.invite,
      cost: input.cost,
      payNote: input.payNote,
    });
    if (input.myLevel != null && me.level == null) {
      const { setPlayerLevel } = await import("@/lib/domain/rating");
      await setPlayerLevel(db, me.id, input.myLevel);
    }
    // The organiser's seat (organisers play too), the names they already have as reserved spots (the
    // americano generator's players, a pasted booking's), and "Court booked by me". `settleNewMatch`
    // says why none of it needs the event's own transaction.
    const { settleNewMatch } = await import("@/lib/domain/newMatch");
    // A held name keeps a past player's record only where the organiser answered for it, and only a
    // record the organiser played with: the past players are read only when an answer came (three bounded reads).
    const picks = cleanPicks(input.picks);
    const records = input.names?.length && picks.length ? heldRecordsFor(await pastPlayerRows(db, me.id, new Date()), input.names, picks) : undefined;
    const settled = await settleNewMatch(db, { event: ev, organiser: me, joinSelf: input.joinSelf, names: input.names, records, booked: input.booked });
    // One event for the new match, and the court booked rides on it: the cards are first drawn after
    // the mark, so they already say "Court booked ✓", and the hooks get `courtBooked` as "I booked it"
    // sends it. A second event for the same moment would sync every card twice (rule 12).
    after(async () => {
      if (input.telegramTicket) await postCardForTicket(db, ev.code, input.telegramTicket);
      if (input.discordTicket) await postCardForDiscordTicket(db, ev.code, input.discordTicket);
      await emitMatchEvent(db, "match.created", ev.code, settled.booked ? { courtBooked: true } : {});
    });
    if (group) {
      after(async () => {
        await notifyGroupMatch(db, group, ev, me.id);
      });
    }
    // The organizer's own calendar entry: the same invite every player gets, the moment the match exists.
    if (settled.joined) after(() => sendCalendarInvite(db, ev, me));
    code = ev.code;
    return { code: ev.code };
  });
  if (res.ok && code) redirect(`/${code}/share`);
  return res;
}

/**
 * "Played with you" and the typed-name question on the create form (the owner, 12 October 2026: "As
 * organizer before and after creating the match should be able to select from players they played with
 * before"): the session's past players as names, days and clubs, never an id. The form asks once, when
 * its names open, so the landing page itself reads nothing more (rule 12): three bounded reads
 * (`pastPlayerRows`) for an organiser who opens the names, none for anybody else.
 */
export async function pastPlayersAction(): Promise<{ chips: string[]; past: PastView[] }> {
  const db = await getDb();
  const me = await getSessionPlayer(db);
  if (!me) return { chips: [], past: [] };
  const list = await pastPlayerRows(db, me.id, new Date());
  return { chips: pickable(list, { ids: new Set(), names: [] }), past: pastViews(list, new Set()) };
}

const updateSchema = z.object({
  title: z.string().max(80).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  durationMinutes: z.literal(MATCH_LENGTHS).optional(),
  tz: z.string().min(1).max(64).optional(),
  venueName: z.string().max(80).optional(),
  venueMapUrl: z.string().max(500).optional(),
  court: z.string().max(40).optional(),
  note: z.string().max(500).optional(),
  capacity: z.coerce.number().int().min(4).max(64).multipleOf(4).optional(),
  whenFull: z.enum(["waitlist", "closed"]).optional(),
  levelMin: z.coerce.number().min(0).max(7).nullable().optional(),
  levelMax: z.coerce.number().min(0).max(7).nullable().optional(),
  levelVerifiedOnly: z.boolean().optional(),
  /** Null takes the tag off; omitted leaves it as it is. */
  category: z.enum(EVENT_CATEGORIES).nullable().optional(),
  ageMin: z.literal(AGE_MINS).nullable().optional(),
  publicListing: z.boolean().optional(),
  bookingUrl: z.string().max(500).optional(),
  cost: z.string().max(40).optional(),
  payNote: z.string().max(120).optional(),
});
export type UpdateEventInput = z.infer<typeof updateSchema>;

const pasteSchema = z.object({
  /** What the person pasted: a platform's share text, its link, or both. Read up to 4,000 characters. */
  text: z.string().max(100_000).transform((t) => t.slice(0, PASTE_TEXT_MAX)),
  /** Links the message carried apart from its text (a Telegram message's link entities). */
  links: z.array(z.string().max(2000)).max(20).optional(),
  /** The browser's zone, for a paste that names no club. */
  tz: z.string().max(64).optional(),
});

/**
 * "Paste your booking" (the owner, 11 October 2026): the share text or the link of a court booked in a
 * platform's app, read into the create form's fields, and the form's address with them filled. Thirty
 * reads a day from one address; one read of a platform's link at most (DECIDING rule 35). Writes
 * nothing but the two counters (`pasteBooking` in src/lib/booking/paste.ts says what each read costs).
 */
export async function readBookingAction(raw: { text: string; links?: string[]; tz?: string }): Promise<PasteResult> {
  const input = pasteSchema.safeParse(raw);
  if (!input.success) return { ok: false, reason: "empty" };
  const db = await getDb();
  const h = await headers();
  const me = await getSessionPlayer(db);
  // The browser's zone, else the edge's; with neither the form's link carries none and the form takes the person's own (never UTC).
  const tz = [input.data.tz, h.get("x-vercel-ip-timezone")].find((z): z is string => typeof z === "string" && isValidTimeZone(z)) ?? null;
  return pasteBooking(db, { text: input.data.text, links: input.data.links, tz, rateKey: clientKeyFrom(h), playerId: me?.id ?? null, selfName: me?.displayName ?? null });
}

/**
 * "Add screenshot" (the owner, 11 October 2026, DECIDING rule 9): one booking screenshot, shrunk by
 * the browser to a JPEG of 1568 pixels at most on its longest side, read once by the AI model, with the
 * paste box's text read beside it by our own reader. The form carries `image` (the file), `text` and
 * `tz`. Five reads a day from one address, twenty a day for everybody, and nothing kept
 * (`readScreenshot` in src/lib/booking/screenshot.ts says what each step costs). The file is checked
 * here by its size before it is read into memory, and there by its own first bytes. Every refusal of
 * the picture answers `reason: "shot"`, and the box says one plain line.
 */
export async function readScreenshotAction(form: FormData): Promise<ShotResult> {
  const image = form instanceof FormData ? form.get("image") : null;
  if (!(image instanceof Blob) || image.size > SHOT_MAX_BYTES) return { ok: false, reason: "shot", why: "type" };
  const input = pasteSchema.safeParse({ text: String(form.get("text") ?? ""), tz: typeof form.get("tz") === "string" ? form.get("tz") : undefined });
  if (!input.success) return { ok: false, reason: "empty" };
  const bytes = new Uint8Array(await image.arrayBuffer());
  const db = await getDb();
  const h = await headers();
  const me = await getSessionPlayer(db);
  const tz = [input.data.tz, h.get("x-vercel-ip-timezone")].find((z): z is string => typeof z === "string" && isValidTimeZone(z)) ?? null;
  return readScreenshot(db, { bytes, type: image.type, text: input.data.text, tz, rateKey: clientKeyFrom(h), playerId: me?.id ?? null, selfName: me?.displayName ?? null });
}

const playAgainSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/) }).nullable().optional();

/**
 * "Play again": any participant or the organizer clones this event on the day and at the time they
 * picked (a week on when they did not) and becomes its organizer. Each player of this match then hears
 * once, "Are you in?" (DECIDING rule 37), after the response and once per old match, however often anybody
 * taps, and only once the match was played. When a game is already there (`existingNextGame`: the one
 * the round announced, or the crew's own game at that hour, which the weekly slot made), the tap lands
 * on it instead of making a second one beside it, and the round, if still unsent, announces that game.
 */
export async function duplicateEventAction(code: string, pick?: { date: string; time: string } | null): Promise<ActionResult<{ code: string }>> {
  let newCode: string | null = null;
  let sameCode: string | null = null;
  const res = await runA(async () => {
    const when = playAgainSchema.parse(pick);
    const { db, detail } = await loadEvent(code);
    const viewer = await getViewer(db, detail);
    const isParticipant = isSeated({ roster: detail.roster }, viewer.player?.id);
    if (!viewer.isCreator && !isParticipant) throw new ActionFailure("forbidden");
    const creatorId = viewer.player?.id ?? detail.event.creatorPlayerId;
    const now = new Date();
    const startsAt = playAgainStart(detail.event, when, now);
    const organizer = viewer.player ?? (await getPlayer(db, creatorId));
    // One game per crew hour: the look and the write hold the hour (`nextGameFor`, `lockCrewHour`).
    const { event: ev, made } = await nextGameFor(db, detail.event, { creatorPlayerId: creatorId, startsAt, now });
    if (!made) {
      sameCode = ev.code;
      // The round goes once per old match: a game the round already announced sends nothing here.
      if (organizer) after(() => notifyPlayAgain(db, detail.event, ev, organizer).then(() => undefined).catch((e) => console.warn("[play again] the round failed", code, e)));
      return { code: ev.code };
    }
    const { joinEvent } = await import("@/lib/domain/slots");
    const joined = await joinEvent(db, { eventId: ev.id, playerId: creatorId }).catch(() => null);
    if (joined?.outcome === "joined" && organizer) after(() => sendCalendarInvite(db, ev, organizer));
    after(async () => {
      await emitMatchEvent(db, "match.created", ev.code, { playAgainOf: code });
      if (organizer) await notifyPlayAgain(db, detail.event, ev, organizer).catch((e) => console.warn("[play again] the round failed", code, e));
    });
    newCode = ev.code;
    return { code: ev.code };
  });
  if (res.ok && sameCode) redirect(`/${sameCode}`);
  if (res.ok && newCode) redirect(`/${newCode}/share`);
  return res;
}

export async function updateEventAction(code: string, raw: UpdateEventInput): Promise<ActionResult<null>> {
  return runA(async () => {
    const input = updateSchema.parse(raw);
    const { db, detail, viewer } = await requireMatchEditor(code);
    const tz = input.tz ?? detail.event.tz;
    const startsAt = input.date && input.time ? zonedTimeToUtc(input.date, input.time, tz) : undefined;
    // The organiser by the session or by the manage link (a second browser, a co-organiser) moves a start
    // already gone; a seated player does not (`mayMoveStart`).
    const result = await updateEvent(db, detail.event.id, viewer.player?.id ?? null, {
      title: input.title,
      startsAt,
      durationMinutes: input.durationMinutes,
      tz: input.tz,
      venueName: input.venueName,
      venueMapUrl: input.venueMapUrl,
      court: input.court,
      note: input.note,
      whenFull: input.whenFull,
      capacity: input.capacity,
      levelMin: input.levelMin,
      levelMax: input.levelMax,
      levelVerifiedOnly: input.levelVerifiedOnly,
      category: input.category,
      ageMin: input.ageMin,
      publicListing: input.publicListing,
      bookingUrl: input.bookingUrl,
      cost: input.cost,
      payNote: input.payNote,
    }, new Date(), { asOrganiser: viewer.isCreator });
    if (result.calendarChanged) after(() => notifyEventUpdated(db, result.event));
    after(async () => {
      await emitMatchEvent(db, "match.updated", code, { calendarChanged: result.calendarChanged });
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

/**
 * The organiser's one tap: banter on or off for every match they organise (`docs/DECIDING.md` rule 18).
 * This match's card and its result picture in the players' chats follow at once, by an edit (rule 5);
 * the organiser's other matches follow at their next change.
 */
export async function setBanterAction(code: string, on: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await requireCreator(code);
    await setBanter(db, detail.event.creatorPlayerId, Boolean(on));
    after(async () => {
      const { channels, syncCards } = await import("@/lib/channels");
      for (const ch of channels()) await syncCards(ch, db, code).catch(() => 0);
      const { closeScoreNudges } = await import("@/lib/afterMatch");
      await closeScoreNudges(db, code).catch(() => 0);
    });
    revalidatePath(`/${code}`);
    revalidatePath(`/${code}/card`);
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
