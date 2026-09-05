"use server";

import { revalidatePath } from "next/cache";
import { verifyPlayerLevel } from "@/lib/domain/ranking";
import { requireCreator, runA, type ActionResult } from "./shared";

/** The organizer of a finished event confirms the levels of the players who took part. */
export async function verifyLevelsAction(code: string, playerIds: string[]): Promise<ActionResult<{ verified: number }>> {
  return runA(async () => {
    const { db, detail } = await requireCreator(code);
    let verified = 0;
    for (const playerId of [...new Set(playerIds)].slice(0, 64)) {
      await verifyPlayerLevel(db, { eventId: detail.event.id, byPlayerId: detail.event.creatorPlayerId, playerId });
      verified++;
    }
    revalidatePath(`/${code}`);
    return { verified };
  });
}
