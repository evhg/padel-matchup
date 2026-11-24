import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, scores, slots } from "@/db/schema";
import { normalName } from "./dupes";
import { DomainError } from "./errors";
import { createEvent } from "./events";
import { parseMatchLength } from "./matchLength";
import { createPlayer } from "./players";
import { settleEventLevels } from "./rating";
import { saveMatchScore, validateSets, type SetScore } from "./scores";
import { confirmLocked, joinEvent, lockEvent } from "./slots";
import { isValidTimeZone } from "@/lib/dates";

/**
 * A match that was played with no match page (the owner, 23 November 2026: a filmed match of the week
 * before, whose numbers had no place to go). The public API cannot do this: a join to a match that is
 * over is refused, and a join by name makes a second record of a player who has one. So the operator's
 * door (`POST /api/admin/played-match`) writes the match as it was: the four players on their own
 * records, the two pairs, and the score, confirmed by the organiser.
 *
 * A player is named by the id of a record, or by a name, and a name makes a new record: only somebody
 * who has no record yet is sent by name. The first player of pair A is the organiser. Every write goes
 * through the function the app itself uses (`createEvent`, `joinEvent` at a moment before the start,
 * `saveMatchScore`, `settleEventLevels`), so the match is the same as one that was made on the day.
 * Nothing is announced: no card, no notice and no mail about a match that is days old.
 * The same organiser and the same start is the same match: a second call answers with the first one.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PlayedMatchInput = {
  startsAt: Date;
  tz: string;
  durationMinutes?: number | null;
  venueName?: string | null;
  /** Two players each: the id of a record, or the name of somebody who has none. */
  teamA: string[];
  teamB: string[];
  sets: { sideA: number; sideB: number }[];
  now?: Date;
};
export type PlayedMatchResult = { code: string; existed: boolean; players: { id: string; name: string; team: "a" | "b"; created: boolean }[] };

export async function recordPlayedMatch(db: Db, input: PlayedMatchInput): Promise<PlayedMatchResult> {
  const now = input.now ?? new Date();
  const named = [...(input.teamA ?? []), ...(input.teamB ?? [])].map((w) => (typeof w === "string" ? w.trim() : ""));
  if (input.teamA?.length !== 2 || input.teamB?.length !== 2 || named.some((w) => !w) || new Set(named.map((w) => w.toLowerCase())).size !== 4) throw new DomainError("invalid", "teams");
  if (!(input.startsAt instanceof Date) || Number.isNaN(input.startsAt.getTime())) throw new DomainError("invalid", "startsAt");
  if (!isValidTimeZone(input.tz)) throw new DomainError("invalid", "tz");
  const durationMinutes = parseMatchLength(input.durationMinutes ?? 90);
  if (durationMinutes == null) throw new DomainError("invalid", "durationMinutes");
  // A match that is still on, or still to come, is made in the app like any other.
  if (input.startsAt.getTime() + durationMinutes * 60_000 > now.getTime()) throw new DomainError("invalid", "not_played");
  const sets: SetScore[] = validateSets((input.sets ?? []).map((s, i) => ({ setNumber: i + 1, sideA: s.sideA, sideB: s.sideB })));
  const ids = named.filter((w) => UUID.test(w));
  const known = ids.length ? await db.select().from(players).where(inArray(players.id, ids)) : [];
  if (known.length !== ids.length) throw new DomainError("not_found");

  // The same organiser and the same start: the match is already there, and nothing is written again.
  const organiserId = UUID.test(named[0]) ? named[0] : null;
  if (organiserId) {
    const [there] = await db
      .select({ code: events.code })
      .from(events)
      .where(and(eq(events.creatorPlayerId, organiserId), eq(events.startsAt, input.startsAt), ne(events.status, "cancelled")))
      .limit(1);
    if (there) return { code: there.code, existed: true, players: [] };
  }

  const four: PlayedMatchResult["players"] = [];
  for (const [i, w] of named.entries()) {
    const row = known.find((p) => p.id === w) ?? (UUID.test(w) ? null : await createPlayer(db, { displayName: w, locale: "en" }));
    if (!row) throw new DomainError("not_found");
    four.push({ id: row.id, name: row.displayName, team: i < 2 ? "a" : "b", created: !UUID.test(w) });
  }
  const ev = await createEvent(db, { creatorPlayerId: four[0].id, type: "match", startsAt: input.startsAt, durationMinutes, tz: input.tz, venueName: input.venueName, whenFull: "closed" });
  const before = new Date(input.startsAt.getTime() - 60_000);
  for (const p of four) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: before });
  await saveMatchScore(db, { eventId: ev.id, playerId: four[0].id, isCreator: true, sets, teamA: [four[0].id, four[1].id], now });
  await db.update(events).set({ status: "past" }).where(eq(events.id, ev.id));
  // A confirmed score moves levels, as it does when the organiser saves it on the match page.
  await settleEventLevels(db, ev.id, now).catch(() => undefined);
  return { code: ev.code, existed: false, players: four };
}

export type FillPlayedInput = {
  code: string;
  /** Two players each, pair A first: the id of a record, or a name. A name takes the place held for it, or an open one. */
  teamA: string[];
  teamB: string[];
  sets: { sideA: number; sideB: number }[];
  now?: Date;
};

/**
 * A match that has its page, but whose line-up and score were never finished there (the owner, 24 November
 * 2026: the organiser's score form looked full with three boxes empty, and once the match was over the page
 * offered no way to put the fourth player in). The operator's door finishes it as it was played, on the
 * same page, so its link, its history and its reel stay where the players know them.
 *
 * Each of the four takes, in this order: the place they already have; the place held for their record;
 * the place held for their name (a new record is made for it, as the held player's own tap would); an open
 * place (a new record for a name). Each seat is the app's own `confirmLocked`, dated a minute before the
 * start, as `recordPlayedMatch` joins. Then the organiser's score, the pairs and the levels, as on the page.
 * A match with a score already answers `existed: true` and writes nothing: the organiser's score is theirs.
 * Nothing is announced.
 */
export async function fillPlayedMatch(db: Db, input: FillPlayedInput): Promise<PlayedMatchResult> {
  const now = input.now ?? new Date();
  const named = [...(input.teamA ?? []), ...(input.teamB ?? [])].map((w) => (typeof w === "string" ? w.trim() : ""));
  if (input.teamA?.length !== 2 || input.teamB?.length !== 2 || named.some((w) => !w) || new Set(named.map((w) => w.toLowerCase())).size !== 4) throw new DomainError("invalid", "teams");
  const sets: SetScore[] = validateSets((input.sets ?? []).map((s, i) => ({ setNumber: i + 1, sideA: s.sideA, sideB: s.sideB })));
  const [ev0] = await db.select().from(events).where(eq(events.code, input.code)).limit(1);
  if (!ev0) throw new DomainError("not_found");
  if (ev0.type !== "match" || ev0.status === "cancelled") throw new DomainError("invalid", "not_a_match");
  if (ev0.startsAt.getTime() + ev0.durationMinutes * 60_000 > now.getTime()) throw new DomainError("invalid", "not_played");
  const [scored] = await db.select({ id: scores.id }).from(scores).where(eq(scores.eventId, ev0.id)).limit(1);
  if (scored) return { code: ev0.code, existed: true, players: [] };
  const ids = named.filter((w) => UUID.test(w));
  const known = ids.length ? await db.select().from(players).where(inArray(players.id, ids)) : [];
  if (known.length !== ids.length) throw new DomainError("not_found");
  if (!ev0.creatorPlayerId || !ids.includes(ev0.creatorPlayerId)) throw new DomainError("invalid", "organiser");

  const before = new Date(ev0.startsAt.getTime() - 60_000);
  const four = await db.transaction(async (tx) => {
    const ev = await lockEvent(tx, ev0.id);
    const seats = await tx.select().from(slots).where(and(eq(slots.eventId, ev.id), sql`${slots.position} <= ${ev.capacity}`)).orderBy(asc(slots.position));
    const seated = (s: (typeof seats)[number]) => Boolean(s.playerId) && (s.status === "joined" || s.status === "confirmed");
    const strangers = seats.filter((s) => seated(s) && !ids.includes(s.playerId as string));
    if (strangers.length > 0) throw new DomainError("invalid", "lineup");
    const used = new Set<string>();
    const out: PlayedMatchResult["players"] = [];
    for (const [i, w] of named.entries()) {
      const team = i < 2 ? "a" : "b";
      const record = known.find((p) => p.id === w) ?? null;
      const free = (s: (typeof seats)[number]) => !used.has(s.id);
      let seat = record ? seats.find((s) => free(s) && s.playerId === record.id && seated(s)) : undefined;
      if (seat) {
        used.add(seat.id);
        out.push({ id: record!.id, name: record!.displayName, team, created: false });
        continue;
      }
      seat =
        (record ? seats.find((s) => free(s) && s.status === "invited" && s.playerId === record.id) : seats.find((s) => free(s) && s.status === "invited" && !s.playerId && normalName(s.invitedName) === normalName(w))) ??
        seats.find((s) => free(s) && (s.status === "empty" || s.status === "declined") && !seated(s));
      if (!seat) throw new DomainError("invalid", "no_place");
      used.add(seat.id);
      const row = record ?? (await createPlayer(tx, { displayName: w, locale: "en" }));
      await confirmLocked(tx, ev, seat, { playerId: row.id, now: before });
      out.push({ id: row.id, name: row.displayName, team, created: !record });
    }
    return out;
  });
  await saveMatchScore(db, { eventId: ev0.id, playerId: ev0.creatorPlayerId, isCreator: true, sets, teamA: [four[0].id, four[1].id], now });
  await db.update(events).set({ status: "past" }).where(eq(events.id, ev0.id));
  await settleEventLevels(db, ev0.id, now).catch(() => undefined);
  return { code: ev0.code, existed: false, players: four };
}
