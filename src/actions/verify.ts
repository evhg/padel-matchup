"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getDb, type Db } from "@/db";
import { getClubByToken, isClubLive } from "@/lib/domain/clubs";
import { getCoachForActor } from "@/lib/domain/coaching";
import { LIMITS } from "@/lib/domain/ratelimit";
import { admitConfirmed, askLevelCheck, decideLevelCheck, isVerifierFor, verifiersFor, type LevelCheckTarget } from "@/lib/domain/verify";
import { announceAdmission, notifyLevelCheckAsked, notifyLevelCheckDecided } from "@/lib/levelChecks";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, assertRate, loadEvent, runA, type ActionResult } from "./shared";

/** Level checks: a player asks in one tap, a coach or club answers in one tap, the confirmed player is seated where they asked. */

export async function askLevelCheckAction(code: string, target: LevelCheckTarget): Promise<ActionResult<{ id: string }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await assertRate(db, "level_check", me.id, LIMITS.levelChecksPerPlayerPerDay);
    const ev = (await loadEvent(code)).detail.event;
    // Only the people who can vouch for this match can be asked from it: a coach at the venue, or the live club.
    if (!isVerifierFor(await verifiersFor(db, ev), target)) throw new ActionFailure("not_found");
    const { check, created } = await askLevelCheck(db, { playerId: me.id, target, eventId: ev.id });
    if (created) after(() => notifyLevelCheckAsked(db, check, me));
    revalidatePath(`/${code}`);
    return { id: check.id };
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
    // A club that is no longer live cannot vouch for anyone, whatever its old manage link still opens.
    if (!club || !isClubLive(club)) throw new ActionFailure("not_found");
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
    await announceAdmission(db, player, admitted, "coachId" in target ? "coach" : "club");
  });
  for (const a of admitted) revalidatePath(`/${a.event.code}`);
  return { admitted: admitted.length };
}
