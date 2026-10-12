import { and, desc, eq, inArray, lte, ne } from "drizzle-orm";
import type { Db } from "@/db";
import { events, players, slots, type Slot } from "@/db/schema";
import { utcToZonedParts } from "@/lib/dates";
import { normalName } from "./dupes";
import { answerOfPick, type PastAnswer, type PastPick, type PastView } from "./pastAsk";
import { DomainError } from "./errors";
import { recordFact } from "./facts";
import { bumpMetric } from "./metrics";
import { LIMITS, takeRate } from "./ratelimit";
import { DELETED_PLAYER_NAME } from "./result";
import { confirmInvite, hasLifeOutside, liveRefusal, lockEvent, type ConfirmOutcome } from "./slots";
import { reachedSince, thatsMeRows, whyNot, type ThatsMeMatch, type ThatsMeRefusal, type ThatsMeRow } from "./thatsMe";

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
 *     session is marked by name, as "That's me" marks it. A record with an email or a Telegram asks
 *     for its proof first (`sign_in_first`); a record outside the limits for another reason reads
 *     whose place it is (`ask_organiser`). Any other record is refused (`confirmInvite`,
 *     `held_record`). A place with a phone keeps no record: it is the WhatsApp number's (`reserveLocked`).
 */

/** A record that played with the organiser: its name, and the start, the club and the zone of the last match they shared. */
export type PastPlayer = { id: string; name: string; last: Date; club: string | null; tz: string };

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
    .select({ id: players.id, name: players.displayName, at: events.startsAt, club: events.venueName, tz: events.tz })
    .from(slots)
    .innerJoin(events, eq(events.id, slots.eventId))
    .innerJoin(players, eq(players.id, slots.playerId))
    .where(and(inArray(slots.eventId, ids), inArray(slots.status, [...TAKEN]), lte(slots.position, events.capacity), ne(players.id, organiserId), ne(players.displayName, DELETED_PLAYER_NAME)));
  const byId = new Map<string, PastPlayer>();
  for (const s of seats) {
    const seen = byId.get(s.id);
    if (!seen || seen.last.getTime() < s.at.getTime()) byId.set(s.id, { id: s.id, name: s.name, last: s.at, club: s.club?.trim() || null, tz: s.tz });
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

/** How many past players the browser gets for the typed-name question: the latest, names, days and clubs only. */
export const PAST_VIEWS_MAX = 100;

/** The day of the last match together, in that match's own zone, as the question shows it and the answer names it. */
export const pastDay = (p: Pick<PastPlayer, "last" | "tz">): string => utcToZonedParts(p.last, p.tz).date;

/**
 * What the browser gets for "Is this Danny, who played with you on Sep 13 at Kross Padel?": a name, a
 * day and a club for each past player not already in the match (`inEvent`), latest first, at most
 * `PAST_VIEWS_MAX`. Never an id: the server finds the record again from the answer (`recordForAnswer`).
 * Pure.
 */
export function pastViews(list: readonly PastPlayer[], inEvent: ReadonlySet<string>, max = PAST_VIEWS_MAX): PastView[] {
  return [...list]
    .filter((p) => !inEvent.has(p.id))
    .sort((a, b) => b.last.getTime() - a.last.getTime())
    .slice(0, max)
    .map((p) => ({ name: p.name, day: pastDay(p), club: p.club }));
}

/**
 * The record an answer names, found again among the organiser's own past players, or null (held by
 * name). A chip (`true`) is the one record of that name (`pastPlayerNamed`); "Yes, that's Danny" is the
 * record of that name whose last match together was on that day at that club, and only when exactly one
 * is; "No, someone new" and no answer are nobody. A name nobody of the list carries is nobody, so a
 * request cannot attach a record the organiser never played with. Pure.
 */
export function recordForAnswer(list: readonly PastPlayer[], name: string, answer: PastAnswer | undefined): PastPlayer | null {
  if (answer === undefined || answer === "new") return null;
  if (answer === true) return pastPlayerNamed(list, name);
  const key = normalName(name);
  if (!key) return null;
  const club = answer.club?.trim() || null;
  const found = list.filter((p) => normalName(p.name) === key && pastDay(p) === answer.day && (p.club ?? null) === club);
  return found.length === 1 ? found[0] : null;
}

/**
 * The records the held names keep, by the name as the server compares it (`normalName`): for each name
 * that is held and has a pick, the record `recordForAnswer` finds. A pick for a name not held is
 * ignored. `reserveNames` holds every other name by name. Pure.
 */
export function heldRecordsFor(list: readonly PastPlayer[], names: readonly string[], picks: readonly PastPick[]): Map<string, string> {
  const out = new Map<string, string>();
  const held = new Set(names.map((n) => normalName(n)).filter(Boolean));
  for (const p of picks) {
    const key = normalName(p.name);
    if (!held.has(key) || out.has(key)) continue;
    const record = recordForAnswer(list, p.name, answerOfPick(p));
    if (record) out.set(key, record.id);
  }
  return out;
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
 * that two records could carry. The record's place in this match is its context, declined too:
 * `heldRecordOf` found that place first, and "That's me" reads no declined place as a place in the
 * match, so a decline from any browser that holds the link locked the record out of its own link
 * (review of 11 October 2026). Null when nothing stands in the way. Pure.
 */
export function heldLinkVerdict(row: ThatsMeRow | undefined): ThatsMeRefusal | null {
  if (!row) return "nobody";
  return whyNot({ ...row, sameName: 1, inContext: true });
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
 * only on `confirmed`, and counts `signin_held_link`. The record is read again first, as "That's me"
 * reads it (`commitThatsMe`): a record that got an address or an account since the decision now proves
 * itself, so the link refuses it (`held_record`). One read by the primary key.
 */
export async function takeHeldLink(db: Db, d: Extract<HeldLinkDecision, { ok: true }>, now = new Date()): Promise<ConfirmOutcome> {
  const [record] = await db.select().from(players).where(eq(players.id, d.playerId)).limit(1);
  if (!record || reachedSince(record)) throw new DomainError("forbidden", "held_record");
  const res = await confirmInvite(db, { inviteCode: d.inviteCode, playerId: d.playerId, now });
  if (res.outcome === "confirmed") {
    await recordFact(db, { kind: "player.thats_me", channel: "web", actorPlayerId: d.playerId, subject: { type: "player", id: d.playerId }, code: d.event.code, data: { folded: false, via: "link" }, at: now });
  }
  return res;
}

/** What the personal link's page shows, once the place's record is known. */
export type HeldRecordViewer = "nobody" | "record" | "other";

/**
 * The limits a record can lift on the personal link's page: the page offers the email code and
 * Telegram (`ReturningPlayer bare`), each only where the deployment runs it (rule 4), and these are
 * the records that one of them signs in. Pure.
 */
export function provableHere(o: { email: boolean; telegram: boolean }): ReadonlySet<ThatsMeRefusal> {
  return new Set<ThatsMeRefusal>([...(o.email ? (["email", "recovery_email"] as const) : []), ...(o.telegram ? (["telegram"] as const) : [])]);
}
const BOTH_DOORS = provableHere({ email: true, telegram: true });

/**
 * The personal link's page over a place that keeps a record: the record itself sees what it always saw;
 * another record never gets "I'm in" (the server refuses it), and reads whose place it is; a browser
 * that knows nobody gets "I'm in" when the record passes the limits (`refusal` null). Otherwise it gets
 * the way to prove who it is first (`sign_in_first`) only when the page offers a door the record can
 * open (`doors`, from `provableHere`); for any other limit (a phone, a push subscription, a match still
 * to come, a crew it runs) it reads whose place it is and is sent to the organiser (`ask_organiser`),
 * never to a door a bare record cannot use. Only the views that offer "I'm in" change. Pure.
 */
export function heldRecordView<V extends string>(
  view: V,
  state: "invited" | "declined" | string,
  viewer: HeldRecordViewer,
  refusal: ThatsMeRefusal | null,
  doors: ReadonlySet<ThatsMeRefusal> = BOTH_DOORS,
): V | "held_for" | "open_again" | "sign_in_first" | "ask_organiser" {
  if (view !== "actions" && view !== "declined") return view;
  if (viewer === "other") return state === "invited" ? "held_for" : "open_again";
  if (viewer === "nobody" && refusal) return doors.has(refusal) ? "sign_in_first" : "ask_organiser";
  return view;
}

