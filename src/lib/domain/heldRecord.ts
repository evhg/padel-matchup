import { and, desc, eq, inArray, lte, ne } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, slots, type Slot } from "@/db/schema";
import { normalName } from "./dupes";
import { DomainError } from "./errors";
import { recordFact } from "./facts";
import { bumpMetric } from "./metrics";
import { LIMITS, takeRate } from "./ratelimit";
import { DELETED_PLAYER_NAME } from "./result";
import { confirmInvite, hasLifeOutside, liveRefusal, lockEvent, type ConfirmOutcome } from "./slots";
import { thatsMeRows, whyNot, type ThatsMeMatch, type ThatsMeRefusal, type ThatsMeRow } from "./thatsMe";

/**
 * A held place that keeps a past player's record (the owner, 11 October 2026). The question was:
 * "Danny now has two records. When you hold a place for a player who played with you before, may the
 * held place keep that player's record?" The answer: "Yes, keep the record". "When you pick a past
 * player for a held place, the place keeps their record. Their personal link then signs them in as
 * that record, inside the "That's me" limits."
 *
 * The place is the row every held place is: reserved, invited, with its own personal link, and with
 * `slots.player_id` set to the record. No column and no migration: a tournament's round 1 already gives
 * a held name a placeholder record the same way, and every reader of a seat asks for a place taken
 * (joined or confirmed), so the record is not seated, does not pay, has not played and hears nothing
 * until it takes the place. A real player's record is told from a placeholder by its life outside the
 * match (`hasLifeOutside`): the personal link folds a placeholder into whoever confirms, as before, and
 * never folds a player's record into anybody.
 *
 *   - Who: `pastPlayerRows`, the records that held a taken seat in a match that started, was not
 *     called off, and that the organiser made or sat in (the last 50). The organiser and a deleted
 *     account are left out. The picker shows a name only when it is the one record of that name there
 *     (`pickable`), and the server finds the record again from the name (`pastPlayerNamed`): no player
 *     id goes to a browser.
 *   - Where: the open spot's "Played with you" chips, and "Keep Danny's matches" on a place already
 *     held by name with no record (`keepRecordFor`, `attachHeldRecord`), which covers every door that
 *     holds a name: the create form, a pasted booking, the americano names, "Paste the names", /new.
 *   - The link: the record itself, or a browser that knows nobody and the record passes every "That's
 *     me" limit but the namesake one, because the link names the record (`heldLinkVerdict`); then the
 *     session is marked by name, as "That's me" marks it. A record outside the limits (an email, a
 *     Telegram and so on) asks for its proof first (`sign_in_first`). Any other record is refused
 *     (`confirmInvite`, `held_record`).
 */

/** A record that played with the organiser: its name and the start of the last match they shared. */
export type PastPlayer = { id: string; name: string; last: Date };

/** How many of the organiser's matches the read looks back over, and how many names the picker shows. */
export const PAST_MATCHES = 50;
export const PAST_PLAYERS_SHOWN = 20;

const TAKEN = ["joined", "confirmed"] as const;

/**
 * The records that sat in a taken seat beside the organiser, or in the organiser's own matches: started,
 * not called off, the last `PAST_MATCHES` of them. Latest first. Three bounded reads, one after the
 * other (rule 8): the organiser's own matches down `events_creator_idx`, the matches the organiser sat
 * in down `slots_player_idx`, then the seats of those matches down `slots_event_position_idx`.
 */
export async function pastPlayerRows(db: Db, organiserId: string, now: Date): Promise<PastPlayer[]> {
  const cols = { id: events.id, startsAt: events.startsAt };
  const made = await db
    .select(cols)
    .from(events)
    .where(and(eq(events.creatorPlayerId, organiserId), ne(events.status, "cancelled"), lte(events.startsAt, now)))
    .orderBy(desc(events.startsAt))
    .limit(PAST_MATCHES);
  const sat = await db
    .select(cols)
    .from(slots)
    .innerJoin(events, eq(events.id, slots.eventId))
    .where(and(eq(slots.playerId, organiserId), inArray(slots.status, [...TAKEN]), lte(slots.position, events.capacity), ne(events.status, "cancelled"), lte(events.startsAt, now)))
    .orderBy(desc(events.startsAt))
    .limit(PAST_MATCHES);
  const ids = [...new Map([...made, ...sat].map((m) => [m.id, m])).values()]
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
    .slice(0, PAST_MATCHES)
    .map((m) => m.id);
  if (ids.length === 0) return [];
  const seats = await db
    .select({ id: players.id, name: players.displayName, at: events.startsAt })
    .from(slots)
    .innerJoin(events, eq(events.id, slots.eventId))
    .innerJoin(players, eq(players.id, slots.playerId))
    .where(and(inArray(slots.eventId, ids), inArray(slots.status, [...TAKEN]), lte(slots.position, events.capacity), ne(players.id, organiserId), ne(players.displayName, DELETED_PLAYER_NAME)));
  const byId = new Map<string, PastPlayer>();
  for (const s of seats) {
    const seen = byId.get(s.id);
    if (!seen || seen.last.getTime() < s.at.getTime()) byId.set(s.id, { id: s.id, name: s.name, last: s.at });
  }
  return [...byId.values()].sort((a, b) => b.last.getTime() - a.last.getTime());
}

/** The one past player of this name, or null: none, or two of the same name ("never one of two of the same name", as rule 34). Pure. */
export function pastPlayerNamed(list: readonly PastPlayer[], name: string | null | undefined): PastPlayer | null {
  const key = normalName(name);
  if (!key) return null;
  const found = list.filter((p) => normalName(p.name) === key);
  return found.length === 1 ? found[0] : null;
}

/**
 * The names the picker offers ("Played with you"): one record of that name among the past players,
 * not in this match already (by record or by name), latest first, at most `PAST_PLAYERS_SHOWN`. Names
 * only: the server finds the record again (`pastPlayerNamed`). Pure.
 */
export function pickable(list: readonly PastPlayer[], here: { ids: ReadonlySet<string>; names: readonly string[] }): string[] {
  const count = new Map<string, number>();
  for (const p of list) count.set(normalName(p.name), (count.get(normalName(p.name)) ?? 0) + 1);
  const taken = new Set(here.names.map((n) => normalName(n)));
  return list
    .filter((p) => count.get(normalName(p.name)) === 1 && !here.ids.has(p.id) && !taken.has(normalName(p.name)))
    .slice(0, PAST_PLAYERS_SHOWN)
    .map((p) => p.name);
}

/** A held place as `keepRecordFor` reads it. */
type HeldRow = Pick<Slot, "kind" | "status" | "playerId" | "invitedName" | "invitedPhone">;

/**
 * "Keep Danny's matches" on a held row: the name of the one past player the place may keep, or null.
 * Only a place held by name with no record and no phone (a phone is the WhatsApp number's own place),
 * and only a record that holds no place in this match. Pure, over the rows the page read already.
 */
export function keepRecordFor(list: readonly PastPlayer[], slot: HeldRow, inEventIds: ReadonlySet<string>): string | null {
  if (slot.kind !== "reserved" || slot.status !== "invited" || slot.playerId || slot.invitedPhone) return null;
  const r = pastPlayerNamed(list, slot.invitedName);
  return r && !inEventIds.has(r.id) ? r.name : null;
}

/**
 * "Keep Danny's matches": the organiser hands a place held by name the record of the past player of
 * that name. The record is read before the match's lock (a read on the pool inside the transaction
 * would wait for ever on PGlite), and every limit is asked again under the lock. Nobody is told: the
 * line-up does not change, and the place keeps its link.
 */
export async function attachHeldRecord(db: Db, input: { eventId: string; slotId: string; organiserId: string; now?: Date }): Promise<{ name: string }> {
  const now = input.now ?? new Date();
  const list = await pastPlayerRows(db, input.organiserId, now);
  return db.transaction(async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    const why = liveRefusal(ev, now);
    if (why) throw new DomainError(why);
    const [slot] = await tx.select().from(slots).where(and(eq(slots.id, input.slotId), eq(slots.eventId, ev.id))).limit(1);
    if (!slot) throw new DomainError("not_found");
    const here = await tx.select({ playerId: slots.playerId }).from(slots).where(eq(slots.eventId, ev.id));
    const name = keepRecordFor(list, slot, new Set(here.flatMap((s) => (s.playerId ? [s.playerId] : []))));
    const record = name ? pastPlayerNamed(list, name) : null;
    if (!record) throw new DomainError("invalid", "no_record");
    await tx.update(slots).set({ playerId: record.id }).where(eq(slots.id, slot.id));
    return { name: record.name };
  });
}

/** The record a held place keeps, or null: a reserved place nobody took, whose record has a life outside the match (not a placeholder). */
export async function heldRecordOf(db: Db, slot: Pick<Slot, "kind" | "status" | "playerId" | "eventId">): Promise<string | null> {
  if (slot.kind !== "reserved" || !slot.playerId || (slot.status !== "invited" && slot.status !== "declined")) return null;
  return (await hasLifeOutside(db, slot.playerId, slot.eventId)) ? slot.playerId : null;
}

/**
 * May the personal link sign a browser that knows nobody in as the record its place keeps? Every
 * "That's me" limit (`whyNot`) but the namesake one: the link names the record itself, never a name
 * that two records could carry. The record's place in this match is its context. Null when nothing
 * stands in the way. Pure.
 */
export function heldLinkVerdict(row: ThatsMeRow | undefined): ThatsMeRefusal | null {
  if (!row) return "nobody";
  return whyNot({ ...row, sameName: 1 });
}

/** The limits read for one record of one match: one bounded read (`thatsMeRows`, for the record's own name). */
export async function heldLinkRefusal(db: Db, m: ThatsMeMatch, record: { id: string; name: string }, now: Date): Promise<ThatsMeRefusal | null> {
  const rows = await thatsMeRows(db, m, { name: record.name, viewerId: record.id, now });
  return heldLinkVerdict(rows.find((r) => r.id === record.id));
}

export type HeldLinkDecision = { ok: true; inviteCode: string; playerId: string; event: { id: string; code: string } } | { ok: false; reason: ThatsMeRefusal | "too_many" };

/**
 * The tap on "I'm in" from a browser that knows nobody, before anything is written. Null when the place
 * keeps no record (a place held by name, or a placeholder): the link works as it always did. Otherwise
 * the "That's me" rates, the address's first, so a refused tap costs an attempt too; then every limit,
 * read now; then the record's own rate (three sign-ins a day into one record).
 */
export async function decideHeldLink(db: Db, input: { inviteCode: string; rateKey: string; now?: Date }): Promise<HeldLinkDecision | null> {
  const now = input.now ?? new Date();
  const [row] = await db
    .select({ slot: slots, name: players.displayName, ev: { id: events.id, code: events.code, groupId: events.groupId, creatorPlayerId: events.creatorPlayerId } })
    .from(slots)
    .innerJoin(events, eq(events.id, slots.eventId))
    .leftJoin(players, eq(players.id, slots.playerId))
    .where(eq(slots.inviteCode, input.inviteCode))
    .limit(1);
  if (!row) return null;
  const recordId = await heldRecordOf(db, row.slot);
  if (!recordId || !row.name) return null;
  if (!(await takeRate(db, "thatsme", input.rateKey, LIMITS.thatsMePerIpPerDay, "day", now))) return { ok: false, reason: "too_many" };
  const why = await heldLinkRefusal(db, row.ev, { id: recordId, name: row.name }, now);
  if (why) {
    await bumpMetric(db, "held_link_refused").catch(() => undefined);
    return { ok: false, reason: why };
  }
  if (!(await takeRate(db, "thatsme_record", recordId, LIMITS.thatsMePerRecordPerDay, "day", now))) return { ok: false, reason: "too_many" };
  return { ok: true, inviteCode: input.inviteCode, playerId: recordId, event: { id: row.ev.id, code: row.ev.code } };
}

/**
 * The tap's write: the personal link's own (`confirmInvite`) for the record, and the fact, with no name
 * in it, when the place was filled. The caller signs the browser in as the record, marked by name,
 * only on `confirmed`, and counts `signin_held_link`.
 */
export async function takeHeldLink(db: Db, d: Extract<HeldLinkDecision, { ok: true }>, now = new Date()): Promise<ConfirmOutcome> {
  const res = await confirmInvite(db, { inviteCode: d.inviteCode, playerId: d.playerId, now });
  if (res.outcome === "confirmed") {
    await recordFact(db, { kind: "player.thats_me", channel: "web", actorPlayerId: d.playerId, subject: { type: "player", id: d.playerId }, code: d.event.code, data: { folded: false, via: "link" }, at: now });
  }
  return res;
}

/** What the personal link's page shows, once the place's record is known. */
export type HeldRecordViewer = "nobody" | "record" | "other";

/**
 * The personal link's page over a place that keeps a record: the record itself sees what it always saw;
 * another record never gets "I'm in" (the server refuses it), and reads whose place it is; a browser
 * that knows nobody gets "I'm in" when the record passes the limits (`passes`), else the way to prove
 * who it is first (`sign_in_first`). Only the views that offer "I'm in" change. Pure.
 */
export function heldRecordView<V extends string>(view: V, state: "invited" | "declined" | string, viewer: HeldRecordViewer, passes: boolean): V | "held_for" | "open_again" | "sign_in_first" {
  if (view !== "actions" && view !== "declined") return view;
  if (viewer === "other") return state === "invited" ? "held_for" : "open_again";
  if (viewer === "nobody" && !passes) return "sign_in_first";
  return view;
}

