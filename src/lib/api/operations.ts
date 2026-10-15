import { z } from "zod";
import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { isValidTimeZone, zonedTimeToUtc } from "@/lib/dates";
import { buildSchedule, type ScheduleResult } from "@/lib/domain/schedule";
import { createEvent } from "@/lib/domain/events";
import { DEFAULT_POINTS, formatOf } from "@/lib/domain/formats";
import { getGroupById, getGroupMember } from "@/lib/domain/groups";
import { changePlayerEmail, findPlayerByPersonalToken, getOrCreatePersonalToken } from "@/lib/domain/identity";
import { AGE_MINS, EVENT_CATEGORIES } from "@/lib/domain/eventTags";
import { MATCH_LENGTHS } from "@/lib/domain/matchLength";
import { createPlayer, getPlayer } from "@/lib/domain/players";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import { setPlayerLevel } from "@/lib/domain/rating";
import type { PairJoinOutcome } from "@/lib/domain/pairSeats";
import { hasLifeOutside, joinEvent, leaveEvent, promotedOf } from "@/lib/domain/slots";
import { whoJoins, type HeldKind } from "@/lib/domain/heldByName";
import { bumpMetric } from "@/lib/domain/metrics";
import { joinWithPolicy } from "@/lib/domain/joining";
import { lineupComplete } from "@/lib/lineup";
import { notifyCreator, notifyLineupChange, notifyPromotion, notifyRefill, sendCalendarInvite, welcomeEmail } from "@/lib/notify";
import { personalUrl } from "@/lib/personal";
import { inviteUrl, manageUrl } from "@/lib/share";
import { ApiError } from "./http";
import { matchToPublic, type PublicMatch } from "./serialize";
import type { WebhookEvent } from "./webhooks";
import type { Channel } from "@/lib/domain/facts";

/** Side effects (emails, webhooks) run after the response when a request context exists; tests pass a no-op. */
export type OpContext = {
  afterwards: (fn: () => Promise<void>) => void;
  emit: (event: WebhookEvent, code: string, extra?: Record<string, unknown>) => void;
  /** Where the request came from, for the fact log. Unset means the web. */
  channel?: Channel;
};
export const NO_SIDE_EFFECTS: OpContext = { afterwards: () => undefined, emit: () => undefined };

const levelField = z.number().min(0).max(7).nullable().optional();

export const createMatchSchema = z.object({
  type: z.enum(["match", "tournament"]).default("match").describe("A match is exactly four players. A tournament is an americano with 4 to 64 players in fours."),
  startsAt: z.string().min(10).max(40).describe("ISO 8601 date-time. With an offset or Z it is absolute; without one it is read in tz. Example: 2026-09-11T19:00"),
  tz: z.string().min(1).max(64).describe("IANA time zone the players live in, for example Asia/Singapore or Asia/Bangkok."),
  durationMinutes: z.literal(MATCH_LENGTHS).optional().describe("How long the court is booked: 60, 90 or 120 minutes. Omit for 90 (a match) or 120 (a tournament). The match page, the cards and the calendar invitation show it."),
  venue: z.string().max(80).optional().describe("Club or court name. Enables the venue board and the booking link."),
  venueMapUrl: z.url().max(500).optional(),
  court: z.string().max(40).optional().describe('Court within the venue, e.g. "3".'),
  capacity: z.number().int().min(4).max(64).optional().describe("Tournaments only, a multiple of 4. Matches are always 4."),
  format: z.enum(["americano", "mexicano", "king"]).optional().describe("Tournaments only. americano: partners rotate, everyone plays everyone. mexicano: courts by standings after round 1. king: winners move up a court, losers down."),
  fixedPairs: z.boolean().default(false).describe("Tournaments only: two partners play every round together, in any format. Pairs sign up together (join_match with partner); a player alone is listed as needing a partner. Americano then rotates the opponents: every pair meets every other pair, and the table ranks pairs."),
  pointsPerMatch: z.number().int().min(4).max(99).optional().describe("Tournaments only: fixed points per match (16, 21, 24, 32). Omit for free scoring; mexicano defaults to 24."),
  gamesTo: z.number().int().min(2).max(12).optional().describe("Tournaments only: first to N games (4, 6, 8) instead of points; the table then ranks by matches won."),
  whenFull: z.enum(["waitlist", "closed"]).default("waitlist"),
  levelMin: levelField.describe("Level range 0 to 7 (Playtomic-style). Omit both for any level."),
  levelMax: levelField,
  verifiedLevelsOnly: z.boolean().default(false).describe("With a range: only levels confirmed by an organizer, a coach or a club walk in; declared levels inside the range ask to join."),
  // Refused rather than dropped: an assistant that sends "ladies" hears which words exist, instead of
  // making an untagged match it believes is tagged.
  category: z.enum(EVENT_CATEGORIES).nullable().optional().describe("Who the match is for: men, women or mixed. Omit for anyone. Information for the players who find it; nobody is checked when they join."),
  ageMin: z.literal(AGE_MINS).nullable().optional().describe("An age tag: 35, 45 or 55 means 35+, 45+ or 55+. Omit for any age. Information only; nobody is checked when they join."),
  title: z.string().max(80).optional(),
  note: z.string().max(500).optional(),
  bookingUrl: z.url().max(500).optional().describe("The club's booking page or confirmation link, shown to players."),
  cost: z.string().max(40).optional().describe("What each player pays, as free text: 400 THB, €8, split 4 ways."),
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
  partner: z.string().min(1).max(40).optional().describe("A fixed-pairs tournament only: the partner's first name. Their spot is reserved with its own invite link (partner.inviteUrl in the answer), which the partner opens to claim it. Omit to join alone: the player is listed as needing a partner. A player already in alone may call again with a partner."),
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

/** The player of a personal token, read only: nothing is saved yet. */
async function playerOfToken(db: Db, token: string): Promise<Player> {
  const p = await findPlayerByPersonalToken(db, token);
  if (!p) throw new ApiError(404, "unknown_token", "No player has this personal token.", "Omit token and pass a name to create a new player, or use the token from an earlier response.");
  return p;
}

/** A token's player with the email and the level the call gave, each saved only where the record has none. */
async function saveGiven(db: Db, p: Player, input: { email?: string; level?: number }): Promise<Player> {
  if (input.email && !p.email) await changePlayerEmail(db, p.id, input.email);
  if (input.level != null && p.level == null) await setPlayerLevel(db, p.id, input.level);
  return (await getPlayer(db, p.id)) ?? p;
}

async function resolvePlayer(db: Db, input: { name?: string; token?: string; email?: string; level?: number }, locale = "en") {
  if (input.token) return saveGiven(db, await playerOfToken(db, input.token), input);
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
    durationMinutes: input.durationMinutes,
    tz: input.tz,
    venueName: input.venue,
    venueMapUrl: input.venueMapUrl,
    court: input.court,
    capacity: input.capacity,
    whenFull: input.whenFull,
    note: input.note,
    format: input.format ?? null,
    fixedPairs: input.fixedPairs,
    pointsPerMatch: input.gamesTo ? null : (input.pointsPerMatch ?? DEFAULT_POINTS[formatOf(input.format)]),
    gamesTo: input.gamesTo ?? null,
    levelMin: input.levelMin ?? null,
    levelMax: input.levelMax ?? null,
    levelVerifiedOnly: input.verifiedLevelsOnly,
    category: input.category ?? null,
    ageMin: input.ageMin ?? null,
    publicListing: input.listOnVenueBoard,
    bookingUrl: input.bookingUrl,
    cost: input.cost,
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
  /** A fixed-pairs night: the partner named, and the link that claims their reserved spot. Private to whoever named them; null otherwise. */
  partner: { name: string; inviteUrl: string } | null;
  /**
   * The match's group, when it has one, and whether the player is a member of it now. A seat in a
   * group that lets anyone in makes a member; a group that asks to join (`askToJoin`) is never
   * joined through a match: `member` stays false and the player asks on the group page.
   */
  group: { code: string; url: string; askToJoin: boolean; member: boolean } | null;
  next: string;
};

/** The group line of a join's answer: one read of the group, one of the membership (both by key). */
async function groupOfJoin(db: Db, groupId: string | null, playerId: string, base: string): Promise<{ row: Awaited<ReturnType<typeof getGroupById>>; line: JoinMatchResult["group"] }> {
  const row = groupId ? await getGroupById(db, groupId) : null;
  if (!row) return { row: null, line: null };
  const member = Boolean(await getGroupMember(db, row.id, playerId));
  return { row, line: { code: row.code, url: `${base}/g/${row.code}`, askToJoin: row.askToJoin, member } };
}

const ASKING_GROUP_NEXT = " The match belongs to a group that asks to join, so the seat did not make the player a member: they ask on the group page and an admin decides.";

export async function joinMatch(db: Db, raw: unknown, ctx: OpContext, locale = "en"): Promise<JoinMatchResult> {
  const input = joinMatchSchema.parse(raw);
  const detail = await getEventByCode(db, input.code);
  if (!detail) throw new ApiError(404, "not_found", `No match with code ${input.code}.`, "Codes are 4 characters and case-sensitive.");
  if (input.partner && !(detail.event.type === "tournament" && detail.event.fixedPairs)) throw new ApiError(422, "invalid_request", "partner is for a fixed-pairs tournament only.", "Omit partner: on this match every player joins alone.");
  // A place held for the name refuses the join before anything is written (`whoJoins`, DECIDING rule
  // 34): a name with no token makes no record (nor does the name of a place that keeps a past player's
  // record), and a token's player is read only, so the given email and level wait until after the rule.
  const known = input.token ? await playerOfToken(db, input.token) : null;
  // A typed name that a record seated or waiting here carries asks first, as the web does (`seatedNamed`,
  // the owner's decision of 15 October 2026): 409 `name_seated`, nothing written. A token is that record's
  // own proof, so a token's call is never asked; the API has no "different person" flag, a fuller name is the way.
  const who = await whoJoins(detail, known, input.name, new Date(), () => resolvePlayer(db, input, locale), { keepsRecord: (id) => hasLifeOutside(db, id, detail.event.id) });
  if ("held" in who) throw new NameHeldError(who.held, who.kind);
  if ("seated" in who) throw new NameSeatedError(who.seated);
  return joinAsPlayer(db, detail, known ? await saveGiven(db, known, input) : who.player, ctx, input.partner);
}

/**
 * The refusal of a join beside a place held for the player's name (DECIDING rule 34, `name_held` from
 * `whoJoins` or `joinWithPolicy`). 409, because the match is fine and the name is the conflict. `held`
 * is the held name as the organiser typed it, so a chat can say it in the player's language
 * (`toastHeldChanged` in `src/lib/telegram/card.ts`); the API's own words are the message and the
 * hint. `kind` says how that person takes the place (`HeldKind`): by name, or as the record the place
 * keeps. A chat meets this only when the place changed while the tap took it (`takeHeld`).
 */
export class NameHeldError extends ApiError {
  constructor(
    public readonly held: string,
    public readonly kind: HeldKind = "by_name",
  ) {
    super(
      409,
      "name_held",
      `A place in this match is held for ${held}, so a second ${held} cannot join beside it.`,
      kind === "record"
        ? `If this is ${held}, use "That's me" on the match page, or the place's own invite link from the organizer. If it is somebody else, join with a fuller name, such as a last name.`
        : `If this is ${held}, take the held place on the match page (type the name, then tap "Take ${held}'s held place") or through the place's own invite link from the organizer. If it is somebody else: without a token, join with a fuller name, such as a last name; with a token, the player adds a last name on My matches (their personal link), then joins again.`,
    );
  }
}

/**
 * The refusal of a typed name that a record holding a seat or a waiting place in this match carries
 * (`name_seated` from `whoJoins`, the owner's decision of 15 October 2026). 409, as `name_held`: the
 * match is fine and the name is the conflict. Nothing is written. `seated` is the name as the line-up
 * shows it, which the match's public data shows already.
 */
export class NameSeatedError extends ApiError {
  constructor(public readonly seated: string) {
    super(
      409,
      "name_seated",
      `${seated} is in this match already, so a second ${seated} cannot join without saying who they are.`,
      `If this is ${seated}, call again with ${seated}'s personal token, or sign in on the match page ("That's me", Face ID or fingerprint, or the email code). If it is somebody else, join with a fuller name, such as a last name.`,
    );
  }
}

/**
 * The join itself, for a player already resolved (API token, Telegram account, Discord, LINE). Same
 * side effects as the web button. `partnerName`: a fixed-pairs night's partner. Who may take the spot
 * is `joinWithPolicy`, the one rule every door asks (a place held for the name, the level range, the
 * organiser's past partners); this function says the answer in the API's words. `takeHeld`: a chat's
 * join, which takes the place held for the player's name (`joinWithPolicy`); `took` then names it.
 */
export async function joinAsPlayer(db: Db, detail: EventDetail, player: Player, ctx: OpContext, partnerName?: string | null, o: { takeHeld?: boolean } = {}): Promise<JoinMatchResult & { took?: string }> {
  const ev = detail.event;
  const range = { min: ev.levelMin, max: ev.levelMax };
  const base = baseUrl();
  const before = lineupComplete(detail.roster, ev.capacity);
  // The level the player holds is the level they join with: the API saved a given level already (`saveGiven`).
  const decision = await joinWithPolicy(db, detail, player, player.level, partnerName, { takeHeld: o.takeHeld });
  if (decision.kind === "name_held") throw new NameHeldError(decision.name);
  if (decision.kind === "level_required") throw new ApiError(422, "level_required", `This match is for levels ${range.min ?? 0}–${range.max ?? 7}. Pass the player's level (0–7) to join.`, "Levels are self-declared in quarter steps; 3.0 is a consistent intermediate player.");
  const token = await getOrCreatePersonalToken(db, player.id);
  const me = { name: player.displayName, personalToken: token, personalUrl: personalUrl(base, token) };
  if (decision.kind === "requested") {
    ctx.afterwards(async () => notifyCreator(db, ev, "requested", `${player.displayName} (${player.level})`, player.id));
    const fresh = (await getEventByCode(db, ev.code))!;
    const next =
      decision.why === "unverified"
        ? "This match takes confirmed levels only, and nobody has confirmed the player's level, so the organizer has to approve. On the match page the player can ask a coach at the club, or the club, to confirm their level; a confirmation seats them automatically."
        : "The player's level is outside the range, so the organizer has to approve. They see the request on the match page; the player sees the answer on the same page.";
    const { line } = await groupOfJoin(db, fresh.event.groupId, player.id, base);
    // The ask carries no partner: say so, so nobody believes the pair is in.
    const pairNote = ev.fixedPairs && partnerName ? " The partner was not reserved: once the organizer says yes, call join_match again with partner." : "";
    return { outcome: "requested", match: matchToPublic(fresh, base, null), player: me, partner: null, group: line, next: next + pairNote };
  }
  // A seat in a crew's match made the player a member already, where the crew lets anyone in (`joinWithPolicy`).
  const res: PairJoinOutcome = decision.result;
  const partner = res.partner?.inviteCode ? { name: res.partner.invitedName ?? "", inviteUrl: inviteUrl(base, ev.code, res.partner.inviteCode) } : null;
  // A single already in who names a partner: a reserved spot changed the line-up.
  if (res.outcome === "already_in" && res.partner) ctx.afterwards(async () => void (await notifyLineupChange(db, res.event, before)));
  const took = decision.took;
  if (res.outcome === "joined" || res.outcome === "waitlisted") {
    ctx.afterwards(async () => {
      // A place held for the name, taken: the organiser hears "Danny confirmed", as from the web's take.
      if (took) await bumpMetric(db, "held_by_name").catch(() => undefined);
      await notifyCreator(db, res.event, res.outcome === "joined" ? (took ? "confirmed" : "joined") : "waitlisted", player.displayName, player.id);
      const fresh = await notifyLineupChange(db, res.event, before, player.id);
      if (res.outcome === "joined") await sendCalendarInvite(db, fresh ?? res.event, player);
    });
    ctx.emit("match.joined", ev.code, { player: { name: player.displayName, level: player.level }, outcome: res.outcome });
    if (res.event.status === "full") ctx.emit("match.full", ev.code);
  }
  const fresh = (await getEventByCode(db, ev.code))!;
  const { row: group, line } = await groupOfJoin(db, fresh.event.groupId, player.id, base);
  const nextText: Record<JoinMatchResult["outcome"], string> = {
    joined: "In. The player can open personalUrl to see the match, add it to a calendar or leave.",
    waitlisted: "The match is full; the player is on the waitlist and moves up automatically when someone leaves.",
    already_in: "This player was already in the match.",
    full: "The match is full and its waitlist is closed.",
    requested: "Waiting for the organizer's approval.",
  };
  const asking = line && line.askToJoin && !line.member && (res.outcome === "joined" || res.outcome === "waitlisted" || res.outcome === "already_in") ? ASKING_GROUP_NEXT : "";
  // Fixed pairs: the partner's link is how the partner claims the spot; nothing is sent to a name (DECIDING rule 24).
  const pairNext = partner
    ? ` Send partner.inviteUrl to ${partner.name}: opening it claims their spot, signed in or by typing their name.`
    : res.noSeatForPartner
      ? ` The player is still in, alone: no spot is free beside them for ${partnerName}, so they stay listed as needing a partner.`
      : ev.fixedPairs && (res.outcome === "joined" || res.outcome === "waitlisted")
        ? " This is a fixed-pairs night and the player joined alone: they are listed as needing a partner until somebody taps Be their partner on the match page, or they join_match again with partner."
        : "";
  return { outcome: res.outcome, match: matchToPublic(fresh, base, group ? { code: group.code, name: group.name } : null), player: me, partner, group: line, next: nextText[res.outcome] + pairNext + asking, ...(took ? { took } : {}) };
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
    const fresh = await notifyLineupChange(db, res.event, before, promotedOf(res.promotion).map((p) => p.playerId));
    await notifyPromotion(db, fresh ?? res.event, res.promotion);
    await notifyRefill(db, res.event.id);
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
