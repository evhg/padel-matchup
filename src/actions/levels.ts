"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { verifyPlayerLevel } from "@/lib/domain/ranking";
import { admitConfirmed, type Admitted } from "@/lib/domain/verify";
import { announceAdmission } from "@/lib/levelChecks";
import { requireCreator, runA, type ActionResult } from "./shared";

/** The organizer of a finished event confirms the levels of the players who took part; a confirmed player is seated wherever they were waiting for exactly that. */
export async function verifyLevelsAction(code: string, playerIds: string[]): Promise<ActionResult<{ verified: number }>> {
  return runA(async () => {
    const { db, detail } = await requireCreator(code);
    let verified = 0;
    const seated: { player: Awaited<ReturnType<typeof verifyPlayerLevel>>; admitted: Admitted[] }[] = [];
    for (const playerId of [...new Set(playerIds)].slice(0, 64)) {
      const player = await verifyPlayerLevel(db, { eventId: detail.event.id, byPlayerId: detail.event.creatorPlayerId, playerId });
      verified++;
      const admitted = await admitConfirmed(db, player, detail.event.creatorPlayerId);
      if (admitted.length) seated.push({ player, admitted });
    }
    if (seated.length) {
      after(async () => {
        for (const s of seated) await announceAdmission(db, s.player, s.admitted, "organizer");
      });
      for (const s of seated) for (const a of s.admitted) revalidatePath(`/${a.event.code}`);
    }
    revalidatePath(`/${code}`);
    return { verified };
  });
}
