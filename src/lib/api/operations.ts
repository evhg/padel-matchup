import { z } from "zod";
import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { isValidTimeZone, zonedTimeToUtc } from "@/lib/dates";
import { buildSchedule, type ScheduleResult } from "@/lib/domain/schedule";
import { createEvent } from "@/lib/domain/events";
import { DEFAULT_POINTS, formatOf } from "@/lib/domain/formats";
import { getGroupById, joinGroup } from "@/lib/domain/groups";
import { changePlayerEmail, findPlayerByPersonalToken, getOrCreatePersonalToken } from "@/lib/domain/identity";
import { hasRange, levelFit } from "@/lib/domain/levels";
import { createPlayer, getPlayer } from "@/lib/domain/players";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import { setPlayerLevel } from "@/lib/domain/rating";
import { createJoinRequest } from "@/lib/domain/requests";
import { joinEvent, leaveEvent } from "@/lib/domain/slots";
import { lineupComplete } from "@/lib/lineup";
import { notifyCreator, notifyLineupChange, notifyPromotion, sendCalendarInvite, welcomeEmail } from "@/lib/notify";
import { personalUrl } from "@/lib/personal";
import { manageUrl } from "@/lib/share";
import { ApiError } from "./http";
import { matchToPublic, type PublicMatch } from "./serialize";
import type { WebhookEvent } from "./webhooks";

/** Side effects (emails, webhooks) run after the response when a request context exists; tests pass a no-op. */
export type OpContext = {
  afterwards: (fn: () => Promise<void>) => void;
  emit: (event: WebhookEvent, code: string, extra?: Record<string, unknown>) => void;
};
export const NO_SIDE_EFFECTS: OpContext = { afterwards: () => undefined, emit: () => undefined };

const levelField = z.number().min(0).max(7).nullable().optional();

export const createMatchSchema = z.object({
  type: z.enum(["match", "tournament"]).default("match").describe("A match is exactly four players. A tournament is an americano with 4 to 64 players in fours."),
  startsAt: z.string().min(10).max(40).describe("ISO 8601 date-time. With an offset or Z it is absolute; without one it is read in tz. Example: 2026-09-11T19:00"),
  tz: z.string().min(1).max(64).describe("IANA time zone the players live in, for example Asia/Singapore or Asia/Bangkok."),
  venue: z.string().max(80).optional().describe("Club or court name. Enables the venue board and the booking link."),
  venueMapUrl: z.url().max(500).optional(),
  court: z.string().max(40).optional().describe('Court within the venue, e.g. "3".'),
  capacity: z.number().int().min(4).max(64).optional().describe("Tournaments only, a multiple of 4. Matches are always 4."),
  format: z.enum(["americano", "mexicano", "king"]).optional().describe("Tournaments only. americano: partners rotate, everyone plays everyone. mexicano: courts by standings after round 1. king: winners move up a court, losers down."),
  pointsPerMatch: z.number().int().min(4).max(99).optional().describe("Tournaments only: fixed points per match (16, 21, 24, 32). Omit for free scoring; mexicano defaults to 24."),
  whenFull: z.enum(["waitlist", "closed"]).default("waitlist"),
  levelMin: levelField.describe("Level range 0 to 7 (Playtomic-style). Omit both for any level."),
  levelMax: levelField,
  title: z.string().max(80).optional(),
  note: z.string().max(500).optional(),
  bookingUrl: z.url().max(500).optional().describe("The club's booking page or confirmation link, shown to players."),
  listOnVenueBoard: z.boolean().default(false).describe("Show the match on the public venue board (/v/{venue-slug}). Off by default."),
  organizer: z.object({
    name: z.string().min(1).max(40).describe("First name is enough."),
    token: z.string().min(8).max(64).optional().describe("Personal token of an existing Kicksmash player, returned by earlier calls, so the same person organizes again."),
    email: z.email().optional().describe("Optional. Gets the organizer link and calendar invite by email."),
    level: z.number().min(0).max(7).optional(),
  }),
  organizerPlays: z.boolean().default(true).describe("Seat the organizer in the match (default). False when they only organize."),
});
export type CreateMatchInput = z.infer<typeof createMatchSchema>;

export const joinMatchSchema = z.object({
  code: z.string().length(4).describe("The 4-character match code from the link, e.g. kicksma.sh/AB12 → AB12."),
  name: z.string().min(1).max(40).optional().describe("Required unless token is given."),
  token: z.string().min(8).max(64).optional().describe("Personal token of an existing player."),
  email: z.email().optional().describe("Optional. Sends a calendar invite that updates itself."),
  level: z.number().min(0).max(7).optional().describe("Needed once when the match has a level range and the player has no level yet."),
});
export type JoinMatchInput = z.infer<typeof joinMatchSchema>;

export const scheduleSchema = z.object({
  players: z.number().int().min(4).max(64).optional().describe("Number of players; ignored when names are given."),
  names: z.array(z.string().min(1).max(40)).min(4).max(64).optional(),
  courts: z.number().int().min(1).max(16).optional().describe("Defaults to floor(players / 4)."),
  rounds: z.number().int().min(1).max(40).optional().describe("Defaults to players − 1 when the field is in fours (every pair partners once), else players."),
  format: z.enum(["americano"]).default("americano"),
  seed: z.number().int().optional().describe("Same seed, same schedule."),
});
export type ScheduleInput = z.infer<typeof scheduleSchema>;

export type CreateMatchResult = {
  match: PublicMatch;
  organizer: { name: string; personalToken: string; personalUrl: string; manageUrl: string };
  shareUrl: string;
  next: string;
};

function parseStartsAt(raw: string, tz: string): Date {
  const s = raw.trim();
  const absolute = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  let d: Date;
  if (absolute) d = new Date(s);
  else {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
    if (!m) throw new ApiError(422, "invalid_request", "startsAt must look like 2026-09-11T19:00 (optionally with an offset or Z).");
    d = zonedTimeToUtc(m[1], m[2], tz);
  }
  if (Number.isNaN(d.getTime())) throw new ApiError(422, "invalid_request", "startsAt is not a valid date-time.");
  const year = 365 * 24 * 3600 * 1000;
  if (Math.abs(d.getTime() - Date.now()) > year) throw new ApiError(422, "invalid_request", "startsAt must be within a year of today.");
  return d;
}

async function resolvePlayer(db: Db, input: { name?: string; token?: string; email?: string; level?: number }, locale = "en") {
  if (input.token) {
    const p = await findPlayerByPersonalToken(db, input.token);
    if (!p) throw new ApiError(404, "unknown_token", "No player has this personal token.", "Omit token and pass a name to create a new player, or use the token from an earlier response.");
    if (input.email && !p.email) await changePlayerEmail(db, p.id, input.email);
    if (input.level != null && p.level == null) await setPlayerLevel(db, p.id, input.level);
    return (await getPlayer(db, p.id)) ?? p;
  }
  const name = (input.name ?? "").trim();
  if (!name) throw new ApiError(422, "invalid_request", "name is required when no token is given.", "A first name is enough. The response returns a personal token you can reuse next time.");
  const p = await createPlayer(db, { displayName: name, locale, email: input.email ?? null });
  if (input.level != null) await setPlayerLevel(db, p.id, input.level);
  return (await getPlayer(db, p.id)) ?? p;
}

/** The same thing the create form does, for programs and assistants. */
export async function createMatch(db: Db, raw: unknown, ctx: OpContext, locale = "en"): Promise<CreateMatchResult> {
  const input = createMatchSchema.parse(raw);
  if (!isValidTimeZone(input.tz)) throw new ApiError(422, "invalid_request", `tz "${input.tz}" is not an IANA time zone.`, "Examples: Asia/Singapore, Asia/Bangkok, Europe/Madrid.");
  const startsAt = parseStartsAt(input.startsAt, input.tz);
  const organizer = await resolvePlayer(db, input.organizer, locale);
  const ev = await createEvent(db, {
    creatorPlayerId: organizer.id,
    type: input.type,
    title: input.title,
    startsAt,
    tz: input.tz,
    venueName: input.venue,
    venueMapUrl: input.venueMapUrl,
    court: input.court,
    capacity: input.capacity,
    whenFull: input.whenFull,
    note: input.note,
    format: input.format ?? null,
    pointsPerMatch: input.pointsPerMatch ?? DEFAULT_POINTS[formatOf(input.format)],
    levelMin: input.levelMin ?? null,
    levelMax: input.levelMax ?? null,
    publicListing: input.listOnVenueBoard,
    bookingUrl: input.bookingUrl,
  });
  if (input.organizerPlays) await joinEvent(db, { eventId: ev.id, playerId: organizer.id }).catch(() => undefined);
  const token = await getOrCreatePersonalToken(db, organizer.id);
  const detail = (await getEventByCode(db, ev.code))!;
  const base = baseUrl();
  ctx.afterwards(async () => {
    if (organizer.email) await welcomeEmail(db, organizer, ev);
  });
  ctx.emit("match.created", ev.code);
  return {
    match: matchToPublic(detail, base, null),
    organizer: { name: organizer.displayName, personalToken: token, personalUrl: personalUrl(base, token), manageUrl: manageUrl(base, ev.code, ev.manageCode) },
    shareUrl: `${base}/${ev.code}`,
    next: "Send shareUrl to the players; anyone who opens it can join with a first name. Keep manageUrl private: it edits or cancels the match. personalUrl signs the organizer in on any device and lists their matches.",
  };
}

export type JoinMatchResult = {
  outcome: "joined" | "waitlisted" | "already_in" | "full" | "requested";
  match: PublicMatch;
  player: { name: string; personalToken: string; personalUrl: string };
  next: string;
};

export async function joinMatch(db: Db, raw: unknown, ctx: OpContext, locale = "en"): Promise<JoinMatchResult> {
  const input = joinMatchSchema.parse(raw);
  const detail = await getEventByCode(db, input.code);
  if (!detail) throw new ApiError(404, "not_found", `No match with code ${input.code}.`, "Codes are 4 characters and case-sensitive.");
  const player = await resolvePlayer(db, input, locale);
  return joinAsPlayer(db, detail, player, ctx);
}

/** The join itself, for a player already resolved (API token, Telegram account, session). Same side effects as the web button. */
export async function joinAsPlayer(db: Db, detail: EventDetail, player: Player, ctx: OpContext): Promise<JoinMatchResult> {
  const ev = detail.event;
  const range = { min: ev.levelMin, max: ev.levelMax };
  const base = baseUrl();
  const before = lineupComplete(detail.roster, ev.capacity);
  const token = await getOrCreatePersonalToken(db, player.id);
  const me = { name: player.displayName, personalToken: token, personalUrl: personalUrl(base, token) };
  if (hasRange(range) && player.id !== ev.creatorPlayerId) {
    const fit = levelFit(range, player.level);
    if (fit === "unknown") throw new ApiError(422, "level_required", `This match is for levels ${range.min ?? 0}–${range.max ?? 7}. Pass the player's level (0–7) to join.`, "Levels are self-declared in quarter steps; 3.0 is a consistent intermediate player.");
    if (fit !== "ok") {
      const already = [...detail.roster, ...detail.waitlist].some((s) => s.playerId === player.id);
      if (!already) {
        await createJoinRequest(db, { eventId: ev.id, playerId: player.id, level: player.level });
        ctx.afterwards(async () => notifyCreator(db, ev, "requested", `${player.displayName} (${player.level})`, player.id));
        const fresh = (await getEventByCode(db, ev.code))!;
        return { outcome: "requested", match: matchToPublic(fresh, base, null), player: me, next: "The player's level is outside the range, so the organizer has to approve. They see the request on the match page; the player sees the answer on the same page." };
      }
    }
  }
  const res = await joinEvent(db, { eventId: ev.id, playerId: player.id });
  if (res.outcome === "joined" || res.outcome === "waitlisted") {
    if (ev.groupId) await joinGroup(db, ev.groupId, player.id).catch(() => undefined);
    ctx.afterwards(async () => {
      await notifyCreator(db, res.event, res.outcome === "joined" ? "joined" : "waitlisted", player.displayName, player.id);
      const fresh = await notifyLineupChange(db, res.event, before, player.id);
      if (res.outcome === "joined") await sendCalendarInvite(db, fresh ?? res.event, player);
    });
    ctx.emit("match.joined", ev.code, { player: { name: player.displayName, level: player.level }, outcome: res.outcome });
    if (res.event.status === "full") ctx.emit("match.full", ev.code);
  }
  const fresh = (await getEventByCode(db, ev.code))!;
  const group = fresh.event.groupId ? await getGroupById(db, fresh.event.groupId) : null;
  const nextText: Record<JoinMatchResult["outcome"], string> = {
    joined: "In. The player can open personalUrl to see the match, add it to a calendar or leave.",
    waitlisted: "The match is full; the player is on the waitlist and moves up automatically when someone leaves.",
    already_in: "This player was already in the match.",
    full: "The match is full and its waitlist is closed.",
    requested: "Waiting for the organizer's approval.",
  };
  return { outcome: res.outcome, match: matchToPublic(fresh, base, group ? { code: group.code, name: group.name } : null), player: me, next: nextText[res.outcome] };
}

export const leaveMatchSchema = z.object({
  code: z.string().length(4).describe("The 4-character match code."),
  token: z.string().min(8).max(64).describe("The player's personal token from an earlier create or join response."),
});

export type LeaveMatchResult = { outcome: "left" | "not_in"; match: PublicMatch; next: string };

export async function leaveMatch(db: Db, raw: unknown, ctx: OpContext): Promise<LeaveMatchResult> {
  const input = leaveMatchSchema.parse(raw);
  const detail = await getEventByCode(db, input.code);
  if (!detail) throw new ApiError(404, "not_found", `No match with code ${input.code}.`, "Codes are 4 characters and case-sensitive.");
  const player = await findPlayerByPersonalToken(db, input.token);
  if (!player) throw new ApiError(404, "unknown_token", "No player has this personal token.", "Use the token from the create or join response.");
  return leaveAsPlayer(db, detail, player, ctx);
}

/** Leaving, with the same follow-ups as the web button: organizer note, line-up email, waitlist promotion, webhook. */
export async function leaveAsPlayer(db: Db, detail: EventDetail, player: Player, ctx: OpContext): Promise<LeaveMatchResult> {
  const ev = detail.event;
  const base = baseUrl();
  const inMatch = [...detail.roster, ...detail.waitlist].some((s) => s.playerId === player.id);
  if (!inMatch) return { outcome: "not_in", match: matchToPublic(detail, base, null), next: "This player is not in the match, nothing changed." };
  const before = lineupComplete(detail.roster, ev.capacity);
  const res = await leaveEvent(db, { eventId: ev.id, playerId: player.id });
  ctx.afterwards(async () => {
    if (!res.wasWaitlisted) await notifyCreator(db, res.event, "left", player.displayName, player.id);
    const fresh = await notifyLineupChange(db, res.event, before, res.promotion?.playerId);
    await notifyPromotion(db, fresh ?? res.event, res.promotion);
  });
  ctx.emit("match.left", ev.code, { player: { name: player.displayName } });
  const fresh = (await getEventByCode(db, ev.code))!;
  return { outcome: "left", match: matchToPublic(fresh, base, null), next: "Left. If someone was on the waitlist they have been moved in and told." };
}

export type { ScheduleResult } from "@/lib/domain/schedule";

/** Pure: the same rotation engine the live tournaments use. */
export function generateSchedule(raw: unknown): ScheduleResult {
  return buildSchedule(scheduleSchema.parse(raw));
}
