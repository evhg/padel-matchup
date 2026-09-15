import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import type { EventDetail } from "@/lib/domain/queries";
import { lineupComplete } from "@/lib/lineup";
import { joinGroup } from "./groups";
import { admission, hasRange } from "./levels";
import { createJoinRequest } from "./requests";
import { joinEvent, type JoinOutcome } from "./slots";

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
 */

export type JoinDecision =
  /** A level range the player has not declared against: the caller must ask before anything happens. */
  | { kind: "level_required" }
  /** Outside the range, or unconfirmed: the organiser decides, and has been asked. */
  | { kind: "requested" }
  /** In, waitlisted, already in, or it filled — `outcome` says which. */
  | { kind: "joined"; result: JoinOutcome };

/** Was the line-up complete before this change? The notices differ, and the rule has one home. */
export const wasComplete = (detail: { roster: { status: string; position: number }[]; event: { capacity: number } }) =>
  lineupComplete(detail.roster as Parameters<typeof lineupComplete>[0], detail.event.capacity);

export async function joinWithPolicy(db: Db, detail: EventDetail, player: Player, level: number | null): Promise<JoinDecision> {
  const ev = detail.event;
  // The organiser is never held to their own range: they set it, and they are already in the match.
  if (hasRange({ min: ev.levelMin, max: ev.levelMax }) && player.id !== ev.creatorPlayerId) {
    const fit = admission(ev, { level, levelVerifiedLevel: player.levelVerifiedLevel });
    if (fit === "unknown") return { kind: "level_required" };
    if (fit !== "ok") {
      // Already on the roster or the waitlist: asking again would open a request for a spot they hold.
      const held = [...detail.roster, ...detail.waitlist].find((s) => s.playerId === player.id);
      if (held) return { kind: "joined", result: { outcome: "already_in", slot: held, event: ev } };
      await createJoinRequest(db, { eventId: ev.id, playerId: player.id, level });
      return { kind: "requested" };
    }
  }
  const result = await joinEvent(db, { eventId: ev.id, playerId: player.id });
  // Joining a crew's match makes you part of the crew, so the next one reaches you too.
  if ((result.outcome === "joined" || result.outcome === "waitlisted") && ev.groupId) {
    await joinGroup(db, ev.groupId, player.id).catch(() => undefined);
  }
  return { kind: "joined", result };
}
