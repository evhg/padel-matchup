import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { deviceHints, events } from "@/db/schema";
import { HINT_KEEP_DAYS } from "./deviceHints";
import { anyDoor, seatedDoors, type OwnDoors } from "./seatedDoors";
import { thatsMeRows, thatsMeVerdict, type ThatsMeMatch, type ThatsMeVerdict } from "./thatsMe";
import { firstName } from "./unreached";

/**
 * The device hint's question, "Welcome back, Tim?" (design B, part 2; the owner's decision of 28 October
 * 2026, DECIDING rule 40). Part 1 keeps a key for a player at each of the player's own acts
 * (`deviceHints.ts`). Here a browser that knows nobody, on a match that is not called off and has not
 * started, sends the same values once, and the server looks for the key among the records this page
 * already shows to such a browser. The key never signs anybody in by itself: it only chooses which
 * question to ask, and the answer goes through a door that exists already.
 *
 * The scope (the privacy rule: the question never discloses a name the page does not show): the records
 * with a seat, a waiting place, or a held place that keeps a record (`HINT_SCOPE_STATUSES` with a
 * record). Never the organiser's unreached list (DECIDING rule 34 says the browser never gets it), never
 * a crew member with no place here, never a join request, never a declined place.
 *
 * The answer, for exactly one record in scope whose key matches, seen within `HINT_KEEP_DAYS`:
 *   - a record with nothing to prove, as "That's me" decides it (`thatsMeVerdict` over the read the tap
 *     makes, `thatsMeRows` for the record's own name): its first name, and the page asks "Welcome back,
 *     Tim?" with "It's me", which signs in exactly as "That's me" does (`decideThatsMe`, `commitThatsMe`);
 *   - a record that can prove itself: its first name and its own doors (`seatedDoors`, the seated
 *     question's rule of 16 October 2026): the email code, Telegram, Face ID;
 *   - anything else: nothing.
 * No record or two and more: nothing at all. The answer never carries an id, a key or which value matched.
 *
 * The second Tim: a record made less than `HINT_FRESH_DAYS` ago that shares no earlier match with anybody
 * is never offered. Such a record is most likely somebody's new record from another browser (the browser
 * that asks knows nobody, so every record here was made elsewhere): the person who made it still has it
 * in that browser, and two phones of one model give one key, so a question about it would most often
 * reach somebody else. An earlier match is one that has already started (before now, not before this
 * match: a match still to come is no past) and was not called off, with another person in a taken seat:
 * beside the record's own taken seat, or in a match the record organised. An organiser with no seat is
 * nobody the record played with. A record with such a match has a past of its own, and is asked about as
 * any other. So a newcomer who joins two posted matches today is not asked about on the second one.
 */

/** Two of one key in scope already means "nothing": the read stops there. */
export const HINT_CANDIDATES_READ = 2;
/** The second Tim: a record younger than this, with no earlier match shared with anybody, is never offered. */
export const HINT_FRESH_DAYS = 7;
/** The places the page shows a record's name on, to a browser that knows nobody: a seat or a waiting place (`joined`, `confirmed`), and a held place that keeps a record (`invited` with a record). */
export const HINT_SCOPE_STATUSES = ["joined", "confirmed", "invited"] as const;

const DAY = 24 * 3600 * 1000;
const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []));
const yes = (v: unknown) => v === true || v === "t" || v === "true";

/** The record ids in scope, from the places the page read already (the line-up and the waiting list): no read. Pure. */
export function hintScopeIds(places: readonly { playerId: string | null; status: string }[]): string[] {
  const ids = new Set<string>();
  for (const s of places) if (s.playerId && (HINT_SCOPE_STATUSES as readonly string[]).includes(s.status)) ids.add(s.playerId);
  return [...ids];
}

/** A match that may ask: not called off, not swept to the past, not started. Pure. */
export function hintOpen(ev: { status: string; startsAt: Date }, now: Date): boolean {
  return ev.status !== "cancelled" && ev.status !== "past" && ev.startsAt.getTime() > now.getTime();
}

/**
 * Whether any record in scope has a hint seen within the year: the page's one read, for a browser that
 * knows nobody, before it mounts the client part that asks. One `exists` down `device_hints_player_idx`
 * over ids the page read already, so it is bounded by the match's own places (rule 12). No ids, no read.
 */
export async function anyHintAmong(db: Db, ids: readonly string[], now: Date): Promise<boolean> {
  if (ids.length === 0) return false;
  const yearAgo = new Date(now.getTime() - HINT_KEEP_DAYS * DAY);
  const [row] = await db
    .select({ id: deviceHints.id })
    .from(deviceHints)
    .where(and(inArray(deviceHints.playerId, [...ids]), gte(deviceHints.lastSeenAt, yearAgo)))
    .limit(1);
  return Boolean(row);
}

/** The match as the question reads it: the rule's match, its code, its state and its start. */
export type HintMatch = ThatsMeMatch & { code: string; status: string; startsAt: Date };

/** One short read of the match by its code: the columns the question needs, never the whole page's read. */
export async function hintMatch(db: Db, code: string): Promise<HintMatch | null> {
  const [ev] = await db
    .select({ id: events.id, code: events.code, groupId: events.groupId, creatorPlayerId: events.creatorPlayerId, status: events.status, startsAt: events.startsAt })
    .from(events)
    .where(eq(events.code, code))
    .limit(1);
  return ev ?? null;
}

/** A record in scope whose key matches, with what its doors and the second-Tim rule read. Never leaves the server. */
export type HintCandidate = { id: string; name: string; email: string | null; recoveryEmail: string | null; telegramId: string | null; passkey: boolean; freshLone: boolean };

/**
 * The records in scope with a row of this key, seen within the year: one statement, at most
 * `HINT_CANDIDATES_READ` rows. The places down `slots_event_position_idx`, each record's row of the key
 * down `device_hints_player_key_idx`; the passkey down `passkeys_player_idx`; and the second-Tim facts
 * only for a record made in the last `HINT_FRESH_DAYS` (a `case`, so an older record reads nothing more):
 * its taken seats down `slots_player_idx` and the matches it made down `events_creator_idx`, each with one
 * look at that match's other seats. "Earlier" is a start before `now`, never before this match's start: a
 * match to come is no past (review, 28 October 2026). Times go in as text (rule 1).
 *
 * Never a record under "Don't recognise my phones" (`players.hints_off`, DECIDING rule 40): an objection
 * stops the use of a key, not only its storage, and a save that raced the switch can keep one row. The
 * condition sits on the players row this statement already reads, so it costs nothing more.
 */
export async function hintCandidates(db: Db, m: Pick<HintMatch, "id">, key: string, now: Date): Promise<HintCandidate[]> {
  const yearAgo = new Date(now.getTime() - HINT_KEEP_DAYS * DAY).toISOString();
  const weekAgo = new Date(now.getTime() - HINT_FRESH_DAYS * DAY).toISOString();
  const started = now.toISOString();
  // Somebody else with a taken seat in match `e` (the alias the two reads below give it). An organiser with no seat is not somebody.
  const another = sql`exists (select 1 from slots b where b.event_id = e.id and b.player_id is not null and b.player_id <> p.id and b.status in ('joined', 'confirmed') and b.position <= e.capacity)`;
  const res = await db.execute(sql`
    select p.id, p.display_name, p.email, p.recovery_email, p.telegram_id::text as telegram_id,
      exists (select 1 from passkeys pk where pk.player_id = p.id) as passkey,
      case when p.created_at >= ${weekAgo}::timestamptz then (
        not exists (
          select 1 from slots a join events e on e.id = a.event_id
           where a.player_id = p.id and a.status in ('joined', 'confirmed') and a.position <= e.capacity
             and e.id <> ${m.id} and e.status <> 'cancelled' and e.starts_at < ${started}::timestamptz
             and ${another}
        )
        and not exists (
          select 1 from events e
           where e.creator_player_id = p.id and e.id <> ${m.id} and e.status <> 'cancelled' and e.starts_at < ${started}::timestamptz
             and ${another}
        )
      ) else false end as fresh_lone
    from players p
    where p.id in (select s.player_id from slots s where s.event_id = ${m.id} and s.player_id is not null and s.status in ('joined', 'confirmed', 'invited'))
      and p.display_name <> 'Deleted player'
      and p.hints_off is null
      and exists (select 1 from device_hints d where d.player_id = p.id and d.key = ${key} and d.last_seen_at >= ${yearAgo}::timestamptz)
    order by p.created_at
    limit ${HINT_CANDIDATES_READ}`);
  return rowsOf(res).map((x) => ({
    id: String(x.id),
    name: String(x.display_name),
    email: x.email == null ? null : String(x.email),
    recoveryEmail: x.recovery_email == null ? null : String(x.recovery_email),
    telegramId: x.telegram_id == null ? null : String(x.telegram_id),
    passkey: yes(x.passkey),
    freshLone: yes(x.fresh_lone),
  }));
}

/** The first step over the candidates, pure: nobody, two or more, the second Tim, or the one record. */
export type HintPick = { kind: "none" } | { kind: "ambiguous" } | { kind: "fresh" } | { kind: "one"; candidate: HintCandidate };

export function hintPick(candidates: readonly HintCandidate[]): HintPick {
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length > 1) return { kind: "ambiguous" };
  const [c] = candidates;
  return c.freshLone ? { kind: "fresh" } : { kind: "one", candidate: c };
}

/** What the server decided, with the record's id and whole name for the server alone. */
export type HintOutcome =
  | { kind: "none" | "ambiguous" | "fresh" | "closed" }
  | { kind: "ask"; id: string; name: string }
  | { kind: "doors"; id: string; name: string; doors: OwnDoors };

/**
 * The second step, pure: the one record, and the verdict "That's me" gives for its name in a browser that
 * knows nobody. "That's me" signs it in: ask. Else its own doors, where it has any: doors. Else nothing
 * (`closed`: a record with no way in that a question could offer). `runs`: the doors this deployment runs.
 */
export function hintOutcomeOf(c: HintCandidate, verdict: ThatsMeVerdict, runs: { email: boolean; telegram: boolean }): HintOutcome {
  if (verdict.ok && verdict.id === c.id && !verdict.fold) return { kind: "ask", id: c.id, name: c.name };
  const doors = seatedDoors([c], runs);
  return anyDoor(doors) ? { kind: "doors", id: c.id, name: c.name, doors } : { kind: "closed" };
}

/**
 * The whole decision for one key on one match: the candidates (one statement), then, for the one record
 * only, the read the tap makes for its name (`thatsMeRows`, one statement). At most two statements.
 */
export async function readHint(db: Db, m: HintMatch, key: string, runs: { email: boolean; telegram: boolean }, now: Date): Promise<HintOutcome> {
  const pick = hintPick(await hintCandidates(db, m, key, now));
  if (pick.kind !== "one") return { kind: pick.kind };
  const rows = await thatsMeRows(db, m, { name: pick.candidate.name, now });
  return hintOutcomeOf(pick.candidate, thatsMeVerdict(rows, null), runs);
}

/** What the browser gets: a first name and, for a record that can prove itself, its own doors. Never an id, a key or a value. */
export type HintAnswer = { name: string; doors: OwnDoors | null };

/** The outcome as the browser may see it. Pure. */
export function hintAnswerOf(o: HintOutcome): HintAnswer | null {
  if (o.kind === "ask") return { name: firstName(o.name), doors: null };
  if (o.kind === "doors") return { name: firstName(o.name), doors: o.doors };
  return null;
}

/** The day's counters an outcome moves (docs/OPERATING.md, "The device hint"). Pure. */
export function hintCounters(o: HintOutcome): string[] {
  switch (o.kind) {
    case "ask":
      return ["hint_asked"];
    case "doors":
      return ["hint_asked", "hint_doors"];
    case "ambiguous":
      return ["hint_ambiguous"];
    case "fresh":
      return ["hint_fresh"];
    default:
      return [];
  }
}
