import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import { emitMatchEvent } from "@/lib/api/webhooks";
import type { JoinOutcome, LeaveResult } from "@/lib/domain/slots";
import { notifyCreator, notifyLineupChange, notifyPromotion, notifyRefill, sendCalendarInvite } from "@/lib/notify";

/**
 * Everything that has to happen once somebody is in a match, or out of it.
 *
 * Six things follow a join and five follow a leave, and forgetting one is silent: nobody sees the
 * missing calendar invitation, and the organiser never learns that a name changed. That was fine
 * while the web form was the only door. It is not any more, so the list lives here and every door
 * calls it — rather than each door carrying its own copy to forget a different item from.
 *
 * Callers decide when: a server action wraps this in `after()`, a webhook route in its own. Nothing
 * here is on the path a person waits on (rule 12).
 */

export async function afterJoin(
  db: Db,
  res: Extract<JoinOutcome, { slot: unknown }>,
  player: Player,
  o: { wasComplete: boolean; code: string; level?: number | null },
): Promise<void> {
  if (res.outcome === "already_in") return;
  await notifyCreator(db, res.event, res.outcome === "joined" ? "joined" : "waitlisted", player.displayName, player.id);
  const fresh = await notifyLineupChange(db, res.event, o.wasComplete, player.id);
  if (res.outcome === "joined") await sendCalendarInvite(db, fresh ?? res.event, player);
  await emitMatchEvent(db, "match.joined", o.code, { player: { name: player.displayName, level: o.level ?? null }, outcome: res.outcome });
  if (res.event.status === "full") await emitMatchEvent(db, "match.full", o.code);
}

export async function afterLeave(db: Db, res: LeaveResult, player: Player, o: { wasComplete: boolean; code: string }): Promise<void> {
  if (!res.wasWaitlisted) await notifyCreator(db, res.event, "left", player.displayName, player.id);
  const fresh = await notifyLineupChange(db, res.event, o.wasComplete, res.promotion?.playerId);
  await notifyPromotion(db, fresh ?? res.event, res.promotion);
  await emitMatchEvent(db, "match.left", o.code, { player: { name: player.displayName } });
  // Nobody was waiting, so the spot is still open: the crew, the club's regulars and whoever asked
  // for this hour hear about it once.
  await notifyRefill(db, res.event.id);
}
