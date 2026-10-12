import { and, asc, eq, exists, gt, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@/db";
import { events, facts, notices, players, scores, slots, tournamentMatches, tournamentRounds, type Event, type Player } from "@/db/schema";
import { utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
import { DomainError } from "./errors";
import { duplicateEvent } from "./events";
import { admission, rangeHolds, waivedByPlay, type Admission, type RangeWaiver } from "./levels";
import { noticeKey } from "./noticeKinds";
import { DELETED_PLAYER_NAME } from "./result";

/**
 * "Play again": the owner's decision of 11 October 2026, option A, "Make the one working group repeat
 * itself", and the answer "Yes, one message each" (DECIDING rule 37).
 *
 * The organiser picks the day and the time; the last game's day and time a week on is the default.
 * Everything else carries over (`duplicateEvent`), and a crew's match stays the crew's. Each player who
 * sat in the last match hears once, "Are you in?", through the notice gate (`notifyPlayAgain` in
 * `src/lib/notify.ts`), and a second tap on the same old match sends nothing (`claimPlayAgainRound`).
 * And a player who already played a finished, scored match with the organiser is not held to that
 * organiser's level range (`admissionAt`).
 */

/** How far ahead the next game may be. A crew plays weekly; a quarter of a year is a typo, not a plan. */
export const PLAY_AGAIN_AHEAD_DAYS = 90;

/** What the control sends: a day and a time as the match's own wall clock. Empty is no pick. */
export type PlayAgainPick = { date?: string | null; time?: string | null } | null | undefined;

const WEEK_MS = 7 * 24 * 3600_000;

/** A calendar day `days` on from "YYYY-MM-DD", as a calendar day: no clock, so no change of clocks. */
function dayPlus(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The control's default: the last game's day and time a week on, as the wall clock where it is played,
 * the first such week after now. Counted on the wall clock, never in 24-hour days, so 18:00 stays 18:00
 * across a change of clocks (seven times 24 hours from a Saturday in summer time is 17:00 in winter time).
 */
export function playAgainDefault(src: Pick<Event, "startsAt" | "tz">, now: Date): { date: string; time: string } {
  const last = utcToZonedParts(src.startsAt, src.tz);
  // Start a week or two short of now and step a week at a time: two steps at most.
  let weeks = Math.max(1, Math.floor((now.getTime() - src.startsAt.getTime()) / WEEK_MS));
  for (;;) {
    const date = dayPlus(last.date, 7 * weeks);
    if (zonedTimeToUtc(date, last.time, src.tz).getTime() > now.getTime()) return { date, time: last.time };
    weeks += 1;
  }
}

/**
 * The control's default when the organiser's next game exists already (`organiserNextGame`): that game's
 * day and time, as this match's wall clock, so one tap lands on it rather than beside it. Else the week-on
 * default. Pure.
 */
export function playAgainOfferWhen(src: Pick<Event, "startsAt" | "tz">, next: Pick<Event, "startsAt"> | null, now: Date): { date: string; time: string } {
  if (next && next.startsAt.getTime() > now.getTime()) {
    const p = utcToZonedParts(next.startsAt, src.tz);
    return { date: p.date, time: p.time };
  }
  return playAgainDefault(src, now);
}

/** The start of the next game: the pick, read in the match's own zone, else the default. Refuses a time already gone. */
export function playAgainStart(src: Pick<Event, "startsAt" | "tz">, pick: PlayAgainPick, now: Date): Date {
  if (!pick?.date && !pick?.time) {
    const d = playAgainDefault(src, now);
    return zonedTimeToUtc(d.date, d.time, src.tz);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pick?.date ?? "") || !/^\d{2}:\d{2}$/.test(pick?.time ?? "")) throw new DomainError("invalid", "startsAt");
  let at: Date;
  try {
    at = zonedTimeToUtc(pick!.date!, pick!.time!, src.tz);
  } catch {
    throw new DomainError("invalid", "startsAt");
  }
  const ahead = at.getTime() - now.getTime();
  if (Number.isNaN(ahead) || ahead <= 0 || ahead > PLAY_AGAIN_AHEAD_DAYS * 24 * 3600_000) throw new DomainError("invalid", "startsAt");
  return at;
}

const SEATED = ["joined", "confirmed"] as const;

/**
 * Who hears that the next game exists: each player who held a taken seat in the last match. Not the
 * person who tapped, not the waiting list, not a seat held for a name (nobody's inbox), and not a
 * player who deleted their account. One read down `slots_event_position_idx`.
 */
export async function playAgainRecipients(db: Db, old: Pick<Event, "id" | "capacity">, tapperId: string): Promise<Player[]> {
  const rows = await db
    .select({ player: players })
    .from(slots)
    .innerJoin(players, eq(players.id, slots.playerId))
    .where(and(eq(slots.eventId, old.id), inArray(slots.status, [...SEATED]), lte(slots.position, old.capacity), isNotNull(slots.playerId), ne(slots.playerId, tapperId), ne(players.displayName, DELETED_PLAYER_NAME)))
    .orderBy(slots.position);
  return rows.map((r) => r.player);
}

/**
 * Was this match played? Started, not called off, and with a score: a match's sets (`scores`, by
 * `scores_event_set_idx`) or a scored game of an americano's rounds (`tournament_rounds_event_round_idx`,
 * then `tournament_matches_round_idx`). A score can be saved from the start of a match, and the score
 * typed in at the court is what "finished" means in practice: the booked length is not waited out.
 * Conditions on `events`, for a query that reads it under its own name.
 */
export function playedOut(now: Date): SQL[] {
  return [
    ne(events.status, "cancelled"),
    lte(events.startsAt, now),
    sql`(exists (select 1 from ${scores} s where s.event_id = ${events}.id) or exists (select 1 from ${tournamentRounds} r join ${tournamentMatches} m on m.round_id = r.id where r.event_id = ${events}.id and m.side_a is not null))`,
  ];
}

/** The fact that says an old match's players heard about its next game: one per old match, ever. */
export const PLAY_AGAIN_FACT = "match.play_again";

/**
 * Who may send an old match's one round of "Are you in?" messages: only for a match that was played
 * (`playedOut`), and only its organiser or a player who held a seat in its line-up from before the
 * start. Joining stays open until the booked length runs out and any seated player may type the score,
 * so a stranger who took a free seat five minutes in could otherwise type 6-0 and spend the round under
 * their own name (and only the organiser may move a start already gone, `updateEvent`). Conditions on
 * `events`; the tapper's seat by `slots_event_player_idx`: taken, inside the capacity, taken by the start.
 */
function roundSender(q: Db, actorPlayerId: string, now: Date): SQL[] {
  const satIn = q
    .select({ one: sql`1` })
    .from(slots)
    .where(and(eq(slots.eventId, events.id), eq(slots.playerId, actorPlayerId), inArray(slots.status, [...SEATED]), lte(slots.position, events.capacity), lte(slots.joinedAt, events.startsAt)));
  return [...playedOut(now), or(eq(events.creatorPlayerId, actorPlayerId), exists(satIn))!];
}

/**
 * Who taps "Play again", as `duplicateEventAction` takes it: the player in this browser, or else the
 * organiser when the manage link proved them (a second browser with no player). Nobody otherwise.
 */
export const playAgainActor = (viewer: { playerId: string | null | undefined; isCreator: boolean }, ev: Pick<Event, "creatorPlayerId">): string | null =>
  viewer.playerId ?? (viewer.isCreator ? ev.creatorPlayerId : null);

/** Would this player's tap send the round (`roundSender`)? The page's help line promises it only then. One read by the key. */
export async function maySendPlayAgainRound(db: Db, oldId: string, actorPlayerId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.id, oldId), ...roundSender(db, actorPlayerId, now)))
    .limit(1);
  return Boolean(row);
}

/**
 * Claims the one round of "Are you in?" messages an old match may send, for a tap that may send it
 * (`roundSender`). A tap that may not send leaves the round for one that may. The old match's row is
 * locked for the read and the write, so two taps at once make one round; the record is the fact log,
 * read on `facts_subject_idx`. True for the tap that may send. `notifyPlayAgain` calls it inside the
 * transaction that reads the round's people, so a read that fails there takes the claim back with it.
 */
export async function claimPlayAgainRound(db: Db, old: Pick<Event, "id" | "code">, next: Pick<Event, "code">, actorPlayerId: string, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, old.id), ...roundSender(tx, actorPlayerId, now)))
      .for("update");
    if (!row) return false;
    const [done] = await tx
      .select({ id: facts.id })
      .from(facts)
      .where(and(eq(facts.subjectType, "match"), eq(facts.subjectId, old.id), eq(facts.kind, PLAY_AGAIN_FACT)))
      .limit(1);
    if (done) return false;
    await tx.insert(facts).values({ kind: PLAY_AGAIN_FACT, channel: "web", actorPlayerId, subjectType: "match", subjectId: old.id, code: old.code, data: { next: next.code } });
    return true;
  });
}

/** The round an old match already sent, and the game it announced; null while none went out. One read on `facts_subject_idx`. */
export async function playAgainRoundOf(db: Db, oldId: string): Promise<{ nextCode: string | null } | null> {
  const [row] = await db
    .select({ data: facts.data })
    .from(facts)
    .where(and(eq(facts.subjectType, "match"), eq(facts.subjectId, oldId), eq(facts.kind, PLAY_AGAIN_FACT)))
    .limit(1);
  if (!row) return null;
  const next = (row.data as { next?: unknown } | null)?.next;
  return { nextCode: typeof next === "string" ? next : null };
}

/**
 * A second "Play again" on the same old match, at the same day and time as the game its round
 * announced: that game, not a second one beside it, so the crew does not split across two matches.
 * Null when there was no round, the game was called off, or the pick is another day or time.
 */
export async function sameNextGame(db: Db, oldId: string, startsAt: Date): Promise<string | null> {
  const round = await playAgainRoundOf(db, oldId);
  if (!round?.nextCode) return null;
  const [ev] = await db.select({ code: events.code, startsAt: events.startsAt, status: events.status }).from(events).where(eq(events.code, round.nextCode)).limit(1);
  return ev && ev.status !== "cancelled" && ev.startsAt.getTime() === startsAt.getTime() ? ev.code : null;
}

/**
 * The crew's game at this hour, when there is one that was not called off: the weekly slot may have made
 * it already ("Make it weekly"), or a member did. The first one made, should two ever exist, so every
 * reader lands on the same game. One read down `events_group_idx`. Null with no crew.
 */
export async function crewGameAt(db: Db, groupId: string | null, startsAt: Date): Promise<Event | null> {
  if (!groupId) return null;
  const [ev] = await db
    .select()
    .from(events)
    .where(and(eq(events.groupId, groupId), eq(events.startsAt, startsAt), ne(events.status, "cancelled")))
    .orderBy(asc(events.createdAt), asc(events.id))
    .limit(1);
  return ev ?? null;
}

/**
 * Holds one crew hour until the transaction ends: "is there a game at this hour?" and the write that
 * follows run one caller at a time, so two "Play again" taps, or a tap and the hourly job, never each
 * read "no game" and each make one. A transaction-scoped advisory lock on the group and the hour, as
 * text (rule 1: no Date in a raw `sql` template); there is no unique index on (group, hour) to lean on,
 * because a game called off keeps its row beside the new one.
 */
export async function lockCrewHour(tx: Db, groupId: string, startsAt: Date): Promise<void> {
  const key = `crew-hour:${groupId}:${startsAt.toISOString()}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/** How far ahead the match page looks for the organiser's next game at the same club. */
export const NEXT_GAME_DAYS = 14;

/** What `organiserAtClub` reads of the old match. */
type OldGame = Pick<Event, "id" | "groupId" | "creatorPlayerId" | "venueSlug" | "type">;

/**
 * The organiser's games at this club, of this kind, not called off, other than the old match, and in the
 * old match's crew (a match with no crew: a game with no crew), so one crew's "Play again" never lands
 * on another crew's game of the same organiser: conditions on `events`.
 */
const organiserAtClub = (old: OldGame): SQL[] => [
  eq(events.venueSlug, old.venueSlug ?? ""),
  eq(events.creatorPlayerId, old.creatorPlayerId),
  eq(events.type, old.type),
  old.groupId ? eq(events.groupId, old.groupId) : isNull(events.groupId),
  ne(events.status, "cancelled"),
  ne(events.id, old.id),
];

/**
 * The next game this match's organiser already has at the same club in the next fourteen days, made by
 * hand or by an earlier tap: the week's game the crew plays, which "Play again" must not split in two.
 * The first by its start, the first made at that start. One read down `events_venue_slug_idx` (the
 * club and the start): the club's games in that window, filtered on the organiser. Null with no club.
 */
export async function organiserNextGame(db: Db, old: OldGame, now: Date): Promise<Event | null> {
  if (!old.venueSlug) return null;
  const [ev] = await db
    .select()
    .from(events)
    .where(and(...organiserAtClub(old), gt(events.startsAt, now), lte(events.startsAt, new Date(now.getTime() + NEXT_GAME_DAYS * 24 * 3600_000))))
    .orderBy(asc(events.startsAt), asc(events.createdAt), asc(events.id))
    .limit(1);
  return ev ?? null;
}

/**
 * The game the match page names as "Next game": the one this match's round announced, while it is
 * still to come and not called off (one read down `events_code_idx`), else the organiser's next game
 * at the club (`organiserNextGame`). Null when there is neither.
 */
export async function nextGameOf(db: Db, old: OldGame, announced: string | null, now: Date): Promise<Event | null> {
  if (announced) {
    const [ev] = await db.select().from(events).where(eq(events.code, announced)).limit(1);
    if (ev && ev.status !== "cancelled" && ev.startsAt.getTime() > now.getTime()) return ev;
  }
  return organiserNextGame(db, old, now);
}

/**
 * The organiser's own game at this club at exactly this start: the game the page's "Next game" names,
 * which a tap at its day and time lands on. One read down `events_venue_slug_idx`. Null with no club.
 */
export async function organiserGameAt(db: Db, old: OldGame, startsAt: Date): Promise<Event | null> {
  if (!old.venueSlug) return null;
  const [ev] = await db
    .select()
    .from(events)
    .where(and(...organiserAtClub(old), eq(events.startsAt, startsAt)))
    .orderBy(asc(events.createdAt), asc(events.id))
    .limit(1);
  return ev ?? null;
}

/**
 * A game "Play again" lands on instead of making one: the game this old match's round already
 * announced at that day and time (`sameNextGame`), else the crew's own game at that hour
 * (`crewGameAt`), else the organiser's own game at that club and that start (`organiserGameAt`: a
 * game made by hand, as the week's game often is), so the group never splits across two matches at
 * one hour. Null: make the game.
 */
export async function existingNextGame(db: Db, old: OldGame, startsAt: Date): Promise<Event | null> {
  const same = await sameNextGame(db, old.id, startsAt);
  if (same) {
    const [ev] = await db.select().from(events).where(eq(events.code, same)).limit(1);
    if (ev) return ev;
  }
  return (await crewGameAt(db, old.groupId, startsAt)) ?? (await organiserGameAt(db, old, startsAt));
}

/**
 * The game a "Play again" tap ends on: the one already there (`existingNextGame`), else a new one with
 * the old match's settings (`duplicateEvent`). For a crew's match the look and the write hold the crew
 * hour (`lockCrewHour`), so two taps at once, or a tap beside the hourly job, make one game.
 */
export async function nextGameFor(db: Db, old: Event, input: { creatorPlayerId: string; startsAt: Date; now: Date }): Promise<{ event: Event; made: boolean }> {
  const run = async (q: Db) => {
    const there = await existingNextGame(q, old, input.startsAt);
    if (there) return { event: there, made: false };
    return { event: await duplicateEvent(q, { sourceEventId: old.id, creatorPlayerId: input.creatorPlayerId, startsAt: input.startsAt, now: input.now }), made: true };
  };
  const groupId = old.groupId;
  if (!groupId) return run(db);
  return db.transaction(async (tx) => {
    await lockCrewHour(tx, groupId, input.startsAt);
    return run(tx);
  });
}

/**
 * Of these people, who already knows about this game: anybody with a place in it (a seat, the waiting
 * list or an invitation), and anybody who already got its crew notice or its "Are you in?" message. So
 * nobody hears about one game twice, whichever of the weekly slot and "Play again" came first. Two
 * bounded reads: the game's places (`slots_event_position_idx`), and these people's notices
 * (`notices_player_created_idx`, at most ninety days of rows each).
 */
export async function toldOfGame(db: Db, eventId: string, playerIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(playerIds)];
  if (ids.length === 0) return new Set();
  const seated = await db
    .select({ id: slots.playerId })
    .from(slots)
    .where(and(eq(slots.eventId, eventId), inArray(slots.playerId, ids), inArray(slots.status, ["joined", "confirmed", "invited"])));
  const heard = await db
    .select({ id: notices.playerId })
    .from(notices)
    .where(and(inArray(notices.playerId, ids), eq(notices.eventId, eventId), inArray(notices.key, [noticeKey("crewMatch"), noticeKey("playAgain")])));
  return new Set([...seated.map((r) => r.id), ...heard.map((r) => r.id)].filter((id): id is string => Boolean(id)));
}

/**
 * Did this player sit in a finished, scored match with this organiser? Both in its line-up (a taken
 * seat inside the capacity, taken by the start: a seat taken after it is a latecomer's, and never
 * counts as having played), the match played (`playedOut`: started, not cancelled, with a score). One
 * bounded read: the player's seats (`slots_player_idx`), each match by its key, the organiser's seat
 * in it (`slots_event_player_idx`), its score.
 */
export async function playedWithOrganiser(db: Db, organiserId: string, playerId: string, now: Date): Promise<boolean> {
  if (organiserId === playerId) return false;
  const mine = alias(slots, "mine");
  const theirs = alias(slots, "theirs");
  const [row] = await db
    .select({ id: events.id })
    .from(mine)
    .innerJoin(events, and(eq(events.id, mine.eventId), lte(mine.position, events.capacity), lte(mine.joinedAt, events.startsAt), ...playedOut(now)))
    .innerJoin(theirs, and(eq(theirs.eventId, events.id), eq(theirs.playerId, organiserId), inArray(theirs.status, [...SEATED]), lte(theirs.position, events.capacity), lte(theirs.joinedAt, events.startsAt)))
    .where(and(eq(mine.playerId, playerId), inArray(mine.status, [...SEATED])))
    .limit(1);
  return Boolean(row);
}

/**
 * Who walks in, with the owner's decision of 11 October 2026: somebody the organiser already played a
 * finished, scored match with skips that organiser's level range (`waivedByPlay`). The
 * confirmed-levels-only check still holds, and a missing level is still asked for. The read runs only
 * for a player the range would hold.
 */
export async function admissionAt(
  db: Db,
  ev: Pick<Event, "levelMin" | "levelMax" | "levelVerifiedOnly" | "creatorPlayerId">,
  p: { id: string; level: number | null | undefined; levelVerifiedLevel?: number | null },
  now = new Date(),
): Promise<Admission> {
  const fit = admission(ev, p);
  if (!rangeHolds(fit) || p.id === ev.creatorPlayerId) return fit;
  return waivedByPlay(ev, p, await playedWithOrganiser(db, ev.creatorPlayerId, p.id, now));
}

/**
 * What a past game with the organiser does for this player's join on this match, for the join bar:
 * "ok" (the range lets them in), "unverified" (the range is waived, and a confirmed-levels-only match
 * still wants a confirmed level, so the bar asks for one), or null (nothing waived: the range does not
 * hold them, or no past game). One read, only for a player the range would hold.
 */
export async function rangeWaiverAt(
  db: Db,
  ev: Pick<Event, "levelMin" | "levelMax" | "levelVerifiedOnly" | "creatorPlayerId">,
  p: { id: string; level: number | null | undefined; levelVerifiedLevel?: number | null },
  now = new Date(),
): Promise<RangeWaiver> {
  if (p.id === ev.creatorPlayerId || !rangeHolds(admission(ev, p))) return null;
  const a = await admissionAt(db, ev, p, now);
  return a === "ok" || a === "unverified" ? a : null;
}
