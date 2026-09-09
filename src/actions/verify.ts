"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getDb, type Db } from "@/db";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { getClubByToken } from "@/lib/domain/clubs";
import { getCoachForActor } from "@/lib/domain/coaching";
import { LIMITS } from "@/lib/domain/ratelimit";
import { admitConfirmed, askLevelCheck, decideLevelCheck, withdrawLevelCheck, type LevelCheckTarget } from "@/lib/domain/verify";
import { notifyLevelCheckAsked, notifyLevelCheckDecided } from "@/lib/levelChecks";
import { notifyLineupChange, notifyRequestDecided } from "@/lib/notify";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, assertRate, loadEvent, runA, type ActionResult } from "./shared";

/** Level checks: a player asks in one tap, a coach or club answers in one tap, the confirmed player is seated where they asked. */

export async function askLevelCheckAction(code: string | null, target: LevelCheckTarget): Promise<ActionResult<{ id: string }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await assertRate(db, "level_check", me.id, LIMITS.levelChecksPerPlayerPerDay);
    const ev = code ? (await loadEvent(code)).detail.event : null;
    const check = await askLevelCheck(db, { playerId: me.id, target, eventId: ev?.id ?? null });
    after(() => notifyLevelCheckAsked(db, check, me));
    if (code) revalidatePath(`/${code}`);
    return { id: check.id };
  });
}

export async function withdrawLevelCheckAction(id: string, code?: string | null): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await withdrawLevelCheck(db, id, me.id);
    if (code) revalidatePath(`/${code}`);
    return null;
  });
}

/** The coach answers from their book: confirm at the declared level or a number of their own, or not yet. */
export async function decideLevelCheckAction(id: string, approve: boolean, level?: number | null): Promise<ActionResult<{ admitted: number }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const found = await getCoachForActor(db, me.id);
    if (!found) throw new ActionFailure("no_coach");
    const out = await decide(db, id, { coachId: found.coach.id }, approve, level, me.id, found.coach.displayName);
    revalidatePath("/coach");
    return out;
  });
}

/** The club answers from its manage page (the claimant's name is the club's). */
export async function decideClubLevelCheckAction(token: string, id: string, approve: boolean, level?: number | null): Promise<ActionResult<{ admitted: number }>> {
  return runA(async () => {
    const db = await getDb();
    const club = await getClubByToken(db, token);
    if (!club) throw new ActionFailure("not_found");
    const out = await decide(db, id, { clubSlug: club.slug }, approve, level, club.claimedBy, club.name);
    revalidatePath(`/v/${club.slug}/manage/${token}`);
    return out;
  });
}

async function decide(db: Db, id: string, target: LevelCheckTarget, approve: boolean, level: number | null | undefined, byPlayerId: string | null, verifierName: string): Promise<{ admitted: number }> {
  const { check, player } = await decideLevelCheck(db, { id, target, approve: Boolean(approve), level: level ?? undefined, byPlayerId });
  const admitted = approve ? await admitConfirmed(db, player, byPlayerId) : [];
  after(async () => {
    await notifyLevelCheckDecided(db, { check, player, verifierName, approve: Boolean(approve), admitted });
    for (const a of admitted) {
      // Seated: the line-up may have just become complete. Waitlisted: it already was.
      const fresh = await notifyLineupChange(db, a.event, a.join.outcome !== "joined", player.id);
      if (a.join.outcome === "joined") await notifyRequestDecided(db, fresh ?? a.event, player, true);
      await emitMatchEvent(db, "match.joined", a.event.code, { player: { name: player.displayName, level: player.level }, outcome: a.join.outcome, approved: true, confirmedBy: "coachId" in target ? "coach" : "club" });
      if (a.event.status === "full") await emitMatchEvent(db, "match.full", a.event.code);
    }
  });
  for (const a of admitted) revalidatePath(`/${a.event.code}`);
  return { admitted: admitted.length };
}
