import type { Db } from "@/db";
import type { Event, Player } from "@/db/schema";
import type { EventDetail } from "@/lib/domain/queries";
import { lineupComplete } from "@/lib/lineup";
import { joinGroup } from "./groups";
import { heldVerdict, takeHeldByName } from "./heldByName";
import { hasRange } from "./levels";
import { joinPair, type PairJoinOutcome } from "./pairSeats";
import { admissionAt } from "./playAgain";
import { createJoinRequest } from "./requests";
import { isHeldPlace, joinEvent } from "./slots";

/**
 * Taking a spot, with all the rules that go with it, in one place.
 *
 * These rules used to live inside the web form's action, which was fine while the web form was the
 * only way in. It is not: a match can now be joined from a WhatsApp thread, and a second copy of
 * "is this player inside the level range" is a second copy that will disagree with the first. The
 * copy that drifts is always the one nobody is looking at.
 *
 * What stays with each caller is what is genuinely theirs: rate limits, the source cookie, page
 * revalidation, and the words used to say what happened.
 *
 * Every door meets here: the web's Join (`joinAction`), the WhatsApp thread, and through
 * `joinAsPlayer` the Telegram ✅ and "+1", the Discord and LINE buttons and `join_match` in the API
 * and MCP. So a rule a join must keep is written once, here, and no door can forget it.
 *
 * A place held for the player's name is the one rule the doors answer in two ways (DECIDING rule 34).
 * The web and the API refuse the join (`name_held`): the match page offers the place itself ("Take
 * Danny's held place"), and the API's player reaches that page through the personal link. A chat
 * cannot send its player to that page: on Discord, LINE and WhatsApp, and on Telegram without the
 * Mini App, the match link opens a browser that knows nobody, and a take there makes a second record
 * from the typed name. So a chat's join takes the place for the account's own record (`takeHeld`),
 * as the web's "Take Danny's held place" does for a browser that knows the record.
 */

export type JoinDecision =
  /**
   * A place is held for this player's name, and the join would seat a second record of the name beside
   * it (DECIDING rule 34, `heldVerdict`). Nothing is written. `name` is the held name as the organiser
   * typed it; each door says it in its own words. Without `takeHeld` this is the answer; with it, only
   * when the place changed between the read and the match's lock (taken, given an address, called off).
   */
  | { kind: "name_held"; name: string }
  /** A level range the player has not declared against: the caller must ask before anything happens. */
  | { kind: "level_required" }
  /** Outside the range (`outside`), or a declared level on a confirmed-levels-only match (`unverified`): the organiser decides, and has been asked. */
  | { kind: "requested"; why: "outside" | "unverified" }
  /**
   * In, waitlisted, already in, or it filled — `outcome` says which; `partner` is the named partner's
   * reserved seat on a fixed-pairs night. `took`: the join took the place held for the player's name
   * (`takeHeld`), and this is the held name as the organiser typed it, so the door can say whose place
   * it was and tell a different person of that name what to do.
   */
  | { kind: "joined"; result: PairJoinOutcome; took?: string };

/** Was the line-up complete before this change? The notices differ, and the rule has one home. */
export const wasComplete = (detail: { roster: { status: string; position: number }[]; event: { capacity: number } }) =>
  lineupComplete(detail.roster as Parameters<typeof lineupComplete>[0], detail.event.capacity);

/**
 * The held place this player's join would leave behind for good: a place the organiser holds for the
 * player's own name, which the player may take by name (`heldVerdict`). A join would seat a second
 * record of that name beside it, and after that no typed name could take the place
 * (`seated_namesake`). The place and its name as the organiser typed it, or null. Pure, over the rows
 * the join read already: the organiser, a player already in the match, a fixed-pairs night and a
 * match that is over or called off are never held back here, by the same rule the web's join asks
 * (`whoJoins`).
 */
export function heldPlaceOf(detail: Pick<EventDetail, "event" | "roster" | "waitlist">, player: Pick<Player, "id" | "displayName">, now = new Date()): { slotId: string; name: string } | null {
  const seats = [...detail.roster, ...detail.waitlist].map((s) => ({ ...s, playerName: s.player?.displayName ?? null }));
  const v = heldVerdict(detail.event, seats, player.displayName, { id: player.id, name: player.displayName }, now);
  return v.ok ? { slotId: v.slotId, name: v.name } : null;
}

/** The held name of `heldPlaceOf`, or null. */
export const heldNameOf = (detail: Pick<EventDetail, "event" | "roster" | "waitlist">, player: Pick<Player, "id" | "displayName">, now = new Date()): string | null =>
  heldPlaceOf(detail, player, now)?.name ?? null;

/**
 * `partnerName`: a fixed-pairs night only, the partner who signs up with the player (`joinPair`).
 * `takeHeld`: a chat's join (the Telegram ✅ and "+1", the Discord and LINE buttons, the WhatsApp
 * JOIN), which takes the place held for the player's name rather than refuse it (see the top of this file).
 */
export async function joinWithPolicy(db: Db, detail: EventDetail, player: Player, level: number | null, partnerName?: string | null, o: { now?: Date; takeHeld?: boolean } = {}): Promise<JoinDecision> {
  const ev = detail.event;
  const now = o.now ?? new Date();
  // A place held for this name (DECIDING rule 34): answered before the range, the request or the seat.
  // The web asked the same before it made a record (`whoJoins`); every other door asks here.
  const held = heldPlaceOf(detail, player, now);
  if (held) {
    if (!o.takeHeld) return { kind: "name_held", name: held.name };
    // The organiser chose the name, so the range does not ask (as on the web's take). The match's lock
    // asks the rule again, as this record (`takeHeldByName`), and writes as the personal link does.
    const taken = await takeHeldByName(db, { ok: true, eventId: ev.id, code: ev.code, slotId: held.slotId, name: held.name }, { id: player.id, name: player.displayName }, now);
    if (!taken.ok) return { kind: "name_held", name: held.name };
    if (ev.groupId) await joinGroup(db, ev.groupId, player.id, "match").catch(() => undefined);
    const outcome = taken.slot.position <= taken.event.capacity ? ("joined" as const) : ("waitlisted" as const);
    return { kind: "joined", result: { outcome, slot: taken.slot, event: taken.event }, took: held.name };
  }
  // A place the organiser holds for this very record (a past player picked for it): the organiser chose
  // the player, so the range does not ask again, and the join takes that place (`joinEvent`).
  const mine = [...detail.roster, ...detail.waitlist].find((s) => s.playerId === player.id);
  const heldForMe = Boolean(mine && isHeldPlace(mine, ev.capacity));
  // The organiser is never held to their own range: they set it, and they are already in the match.
  // Nor is a player who already played a finished, scored match with them (DECIDING rule 37).
  if (hasRange({ min: ev.levelMin, max: ev.levelMax }) && player.id !== ev.creatorPlayerId && !heldForMe) {
    const fit = await admissionAt(db, ev, { id: player.id, level, levelVerifiedLevel: player.levelVerifiedLevel });
    if (fit === "unknown") return { kind: "level_required" };
    if (fit !== "ok") {
      // Already on the roster or the waitlist: asking again would open a request for a spot they hold.
      const held = [...detail.roster, ...detail.waitlist].find((s) => s.playerId === player.id);
      // Already in (the organiser said yes): naming a partner is not a new ask.
      if (held && ev.fixedPairs && partnerName) return { kind: "joined", result: await joinPair(db, { eventId: ev.id, playerId: player.id, partnerName }) };
      if (held) return { kind: "joined", result: { outcome: "already_in", slot: held, event: ev } };
      await createJoinRequest(db, { eventId: ev.id, playerId: player.id, level });
      return { kind: "requested", why: fit === "unverified" ? "unverified" : "outside" };
    }
  }
  const result = ev.fixedPairs && partnerName ? await joinPair(db, { eventId: ev.id, playerId: player.id, partnerName }) : await joinEvent(db, { eventId: ev.id, playerId: player.id });
  // Joining a crew's match makes you part of the crew, so the next one reaches you too — unless the
  // crew asks to join, where the seat is the match's and the crew stays the admins' to choose.
  if ((result.outcome === "joined" || result.outcome === "waitlisted") && ev.groupId) {
    await joinGroup(db, ev.groupId, player.id, "match").catch(() => undefined);
  }
  return { kind: "joined", result };
}

/**
 * "Be their partner" on a fixed-pairs night: the range check before the place beside a single. A ranged
 * night holds a newcomer to the range the way the Join button does, with the same waiver for a player
 * who already played a finished, scored match with the organiser (`admissionAt`). The organiser, and
 * somebody already in (the organiser let them in), pair without a second check.
 */
export async function partnerAdmission(
  db: Db,
  ev: Pick<Event, "levelMin" | "levelMax" | "levelVerifiedOnly" | "creatorPlayerId">,
  me: Pick<Player, "id" | "level" | "levelVerifiedLevel">,
  seated: boolean,
  now = new Date(),
): Promise<"ok" | "level_required" | "forbidden"> {
  if (!hasRange({ min: ev.levelMin, max: ev.levelMax }) || me.id === ev.creatorPlayerId || seated) return "ok";
  const fit = await admissionAt(db, ev, me, now);
  if (fit === "unknown") return "level_required";
  return fit === "ok" ? "ok" : "forbidden";
}
