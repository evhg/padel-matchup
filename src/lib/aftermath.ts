import type { Db } from "@/db";
import type { Event, Player, Slot } from "@/db/schema";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { getPlayer } from "@/lib/domain/players";
import { promotedOf, type JoinOutcome, type LeaveResult, type Promotion } from "@/lib/domain/slots";
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
  const fresh = await notifyLineupChange(db, res.event, o.wasComplete, promotedOf(res.promotion).map((p) => p.playerId));
  await notifyPromotion(db, fresh ?? res.event, res.promotion);
  await emitMatchEvent(db, "match.left", o.code, { player: { name: player.displayName } });
  // Nobody was waiting, so the spot is still open: the crew, the club's regulars and whoever asked
  // for this hour hear about it once.
  await notifyRefill(db, res.event.id);
}

/**
 * A held place filled, by its personal link or by its name on the plain link: the organiser hears
 * "Danny confirmed" (or that a fixed-pairs partner waits), and a place on the list brings the line-up
 * notice and the calendar invitation. The record is read again, because the confirmation may have
 * saved an email on it.
 */
export async function afterConfirm(db: Db, res: { slot: Slot; event: Event }, player: Player, o: { wasComplete: boolean }): Promise<void> {
  const fresh = (await getPlayer(db, player.id)) ?? player;
  const listed = res.slot.position <= res.event.capacity;
  await notifyCreator(db, res.event, listed ? "confirmed" : "waitlisted", fresh.displayName, fresh.id);
  if (!listed) return;
  const ev = await notifyLineupChange(db, res.event, o.wasComplete, fresh.id);
  await sendCalendarInvite(db, ev ?? res.event, fresh);
}

/**
 * A held place freed because its person was in already (`confirmInvite`'s "already_in"): what follows
 * a leave. The line-up notice, the players who moved up and the organiser's line about each of them,
 * and, when nobody moved up on a night without fixed pairs, the free spot offered once.
 */
export async function afterRelease(db: Db, res: { event: Event; promotion?: Promotion | null }, o: { wasComplete: boolean }): Promise<void> {
  const fresh = await notifyLineupChange(db, res.event, o.wasComplete, promotedOf(res.promotion).map((p) => p.playerId));
  await notifyPromotion(db, fresh ?? res.event, res.promotion ?? null);
  if (!res.promotion && !res.event.fixedPairs) await notifyRefill(db, res.event.id);
}
