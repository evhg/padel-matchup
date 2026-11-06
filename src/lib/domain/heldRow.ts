import type { Db } from "@/db";
import type { Event } from "@/db/schema";
import { normalName } from "./dupes";
import { heldVerdict, placeOf, type HeldMatch, type HeldSeat, type HeldViewer } from "./heldByName";
import { liveRefusal } from "./slots";
import { heldRecordFacts, type DoorsRun } from "./thatsMe";

/**
 * The button on a held row and the organiser's one message (DECIDING rule 34). The owner decided on 6
 * November 2026: "Build A and C".
 *
 * Erik held three places one at a time with the "Played with you" names, and each place kept the past
 * player's record. After each hold the page opened "Send them their personal link" by itself, so Erik
 * sent three WhatsApp messages one at a time. Option C: "A 'That's me' button on each held row, in place
 * of the typed name. Every player confirms with one tap, also in a new browser." Option A: "One message
 * for the whole crew", with the match link for all held players.
 *
 * So each held row shows "I'm Danny" to a browser that may take that place, and one tap does it. The
 * kind says what the tap runs; the page sends the kind and nothing else:
 *
 *   - `by_name`: a place held by name, which `heldVerdict` lets this browser take
 *     (`takeHeldPlaceAction`);
 *   - `record`: a place that keeps a record "That's me" signs in, for a browser that knows nobody
 *     (`takeHeldRecordAction`: the sign-in by name and the place in one request);
 *   - `doors`: a place that keeps a record that proves itself, for a browser that knows nobody. The tap
 *     reads the record's own doors (`heldRowDoorsAction`, the owner's decision D4 of 16 October 2026);
 *   - `fold`: the record this browser's own new record folds into (`thatsMeAction`), only when this
 *     browser's record holds a seat or a waiting place here;
 *   - `mine`: the place keeps this browser's own record (`joinAction`).
 *
 * No row offer but `mine` on a place with a typed email or phone (`addressed`: the address's own way
 * fills it) or on one of two held places of a name (`heldTwin`: "never one of two of the same name").
 * No offer at all on a fixed-pairs night, past capacity, on a match called off or over, or for the
 * organiser.
 */

export type HeldRowKind = "by_name" | "record" | "doors" | "fold" | "mine";
export type HeldRowOffer = { slotId: string; name: string; kind: HeldRowKind };

/**
 * What the page knows of the records on held places, from the rows it read already (`thatsMeOffer`):
 * the ones "That's me" signs in, the ones that prove themselves through their own doors, and the record
 * this browser's own new record folds into. Ids only.
 */
export type HeldRowFacts = { claimable: ReadonlySet<string>; doors: ReadonlySet<string>; fold: string | null };

/** A place held for a typed email or phone: the address's own way fills it (the emailed link, the WhatsApp JOIN). */
export const addressed = (s: Pick<HeldSeat, "invitedEmail" | "invitedPhone">): boolean => Boolean(s.invitedEmail || s.invitedPhone);

/** The names a held place carries, as the rule compares them: the typed name, and the record's own name when it keeps one. Two letters or more, each once. */
export function heldKeys(s: Pick<HeldSeat, "invitedName" | "playerName" | "playerId">): string[] {
  const keys = [normalName(s.invitedName), ...(s.playerId ? [normalName(s.playerName)] : [])].filter((k) => k.length >= 2);
  return [...new Set(keys)];
}

/** Another held place (status `invited`) carries one of this place's names, by its typed name or by its record's name. Pure. */
export function heldTwin(seats: readonly HeldSeat[], s: HeldSeat): boolean {
  const mine = heldKeys(s);
  if (mine.length === 0) return false;
  return seats.some((o) => o.id !== s.id && o.status === "invited" && heldKeys(o).some((k) => mine.includes(k)));
}

/** A held place on the line-up: reserved, nobody took it, inside the capacity. */
const heldOnRoster = (s: HeldSeat, capacity: number): boolean => s.kind === "reserved" && s.status === "invited" && s.position <= capacity;

/**
 * The held places whose records the organiser's one message must ask about: on the line-up, with a
 * record, no typed address and no twin. None on a fixed-pairs night. Pure.
 */
export function rowCandidates(m: Pick<HeldMatch, "fixedPairs"> & Pick<Event, "capacity">, seats: readonly HeldSeat[]): HeldSeat[] {
  if (m.fixedPairs) return [];
  return seats.filter((s) => heldOnRoster(s, m.capacity) && Boolean(s.playerId) && !addressed(s) && !heldTwin(seats, s));
}

/**
 * One offer for each held row this browser may act on, in the order of the rows. Pure, over the rows the
 * page read already and what `thatsMeOffer` read from them (`facts`), so it costs no read. The tap asks
 * the same rules again on the server.
 */
export function heldRowOffers(m: HeldMatch & Pick<Event, "capacity">, seats: readonly HeldSeat[], viewer: HeldViewer, facts: HeldRowFacts, now: Date): HeldRowOffer[] {
  if (liveRefusal(m, now) || m.fixedPairs || (viewer && viewer.id === m.creatorPlayerId)) return [];
  // The fold needs a place of the viewer's own record here: a crew member of the name with no place gets no button.
  const viewerPlace = viewer ? seats.some((s) => s.playerId === viewer.id && placeOf(s)) : false;
  const out: HeldRowOffer[] = [];
  for (const s of seats) {
    if (!heldOnRoster(s, m.capacity)) continue;
    const name = s.playerName ?? s.invitedName ?? "";
    if (s.playerId && viewer && viewer.id === s.playerId) {
      out.push({ slotId: s.id, name, kind: "mine" });
      continue;
    }
    if (addressed(s) || heldTwin(seats, s)) continue;
    if (!s.playerId) {
      const v = heldVerdict(m, seats, s.invitedName ?? "", viewer, now);
      if (v.ok && v.slotId === s.id) out.push({ slotId: s.id, name: v.name, kind: "by_name" });
      continue;
    }
    if (viewer) {
      if (facts.fold === s.playerId && viewerPlace) out.push({ slotId: s.id, name, kind: "fold" });
      continue;
    }
    if (facts.claimable.has(s.playerId)) out.push({ slotId: s.id, name, kind: "record" });
    else if (facts.doors.has(s.playerId)) out.push({ slotId: s.id, name, kind: "doors" });
  }
  return out;
}

/** The kinds a browser that knows nobody takes from the plain match link: the places the one message names. */
const FROM_THE_LINK: ReadonlySet<HeldRowKind> = new Set(["by_name", "record", "doors"]);

/**
 * The one message's two lists: the held places on the line-up that a browser that knows nobody can take
 * from the plain match link (`offers` for no viewer: by name, a record "That's me" signs in, a record
 * with its own doors), and the others, which keep their personal link on their row. Each by the name the
 * row shows, in the order of the line-up. Pure.
 */
export function heldMessageParts(seats: readonly HeldSeat[], capacity: number, offers: readonly HeldRowOffer[]): { names: string[]; others: string[] } {
  const kinds = new Map(offers.map((o) => [o.slotId, o.kind]));
  const names: string[] = [];
  const others: string[] = [];
  for (const s of [...seats].sort((a, b) => a.position - b.position)) {
    if (!heldOnRoster(s, capacity)) continue;
    const kind = kinds.get(s.id);
    (kind && FROM_THE_LINK.has(kind) ? names : others).push(s.playerName ?? s.invitedName ?? "");
  }
  return { names, others };
}

/**
 * The organiser's one message for this line-up (`HeldMessage`, under the line-up and on the share page).
 * One bounded read (`heldRecordFacts`), and only while a held place keeps a record with no typed address
 * and no twin; none otherwise. Nothing on a fixed-pairs night or on a match called off or over, where no
 * message shows.
 */
export async function heldMessageOf(db: Db, m: HeldMatch & Pick<Event, "id" | "groupId" | "capacity">, seats: readonly HeldSeat[], now: Date, runs: DoorsRun): Promise<{ names: string[]; others: string[] }> {
  if (m.fixedPairs || liveRefusal(m, now)) return { names: [], others: [] };
  const ids = rowCandidates(m, seats).flatMap((s) => (s.playerId ? [s.playerId] : []));
  const facts = ids.length ? await heldRecordFacts(db, m, ids, now, runs) : { claimable: new Set<string>(), doors: new Set<string>() };
  return heldMessageParts(seats, m.capacity, heldRowOffers(m, seats, null, { ...facts, fold: null }, now));
}
