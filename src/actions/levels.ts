"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { isDomainError } from "@/lib/domain/errors";
import { verifyPlayerLevel } from "@/lib/domain/ranking";
import { admitConfirmed, type Admitted } from "@/lib/domain/verify";
import { announceAdmission } from "@/lib/levelChecks";
import { requireCreator, runA, type ActionResult } from "./shared";

/** One tick as the organizer saw it: the player and the number next to their name. */
export type LevelPick = { id: string; level: number };

/**
 * The organizer of a finished event confirms the levels of the players who took part, at the numbers they were shown; a confirmed player is seated wherever they were waiting for exactly that.
 * A number that moved since the page was drawn is not confirmed blind: that player is handed back by name so the organizer can look again.
 */
export async function verifyLevelsAction(code: string, picks: LevelPick[]): Promise<ActionResult<{ verified: number; skipped: { id: string; name: string }[] }>> {
  return runA(async () => {
    const { db, detail } = await requireCreator(code);
    let verified = 0;
    const skipped: { id: string; name: string }[] = [];
    const seated: { player: Awaited<ReturnType<typeof verifyPlayerLevel>>; admitted: Admitted[] }[] = [];
    for (const [playerId, level] of new Map(picks.slice(0, 64).map((p) => [p.id, p.level] as const))) {
      let player: Awaited<ReturnType<typeof verifyPlayerLevel>>;
      try {
        player = await verifyPlayerLevel(db, { eventId: detail.event.id, byPlayerId: detail.event.creatorPlayerId, playerId, level });
      } catch (e) {
        if (!isDomainError(e) || e.message !== "level_changed") throw e;
        skipped.push({ id: playerId, name: detail.roster.find((s) => s.playerId === playerId)?.player?.displayName ?? "?" });
        continue;
      }
      verified++;
      const admitted = await admitConfirmed(db, player, detail.event.creatorPlayerId);
      if (admitted.length) seated.push({ player, admitted });
    }
    if (seated.length) {
      after(async () => {
        for (const s of seated) await announceAdmission(db, s.player, s.admitted, "organizer", detail.event.creatorPlayerId);
      });
      for (const s of seated) for (const a of s.admitted) revalidatePath(`/${a.event.code}`);
    }
    revalidatePath(`/${code}`);
    return { verified, skipped };
  });
}
