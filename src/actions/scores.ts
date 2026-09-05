"use server";

import { revalidatePath } from "next/cache";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { applyEventLevels } from "@/lib/domain/rating";
import { saveMatchScore, type SetScore } from "@/lib/domain/scores";
import { after } from "next/server";
import { getViewer, loadEvent, runA, type ActionResult } from "./shared";

export async function saveScoreAction(code: string, sets: SetScore[], teamA?: string[]): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const viewer = await getViewer(db, detail);
    await saveMatchScore(db, {
      eventId: detail.event.id,
      playerId: viewer.player?.id ?? null,
      isCreator: viewer.isCreator,
      sets,
      teamA: teamA && teamA.length === 2 ? teamA : undefined,
    });
    // The organizer's confirmation is the moment results nudge levels (once per match).
    if (viewer.isCreator) await applyEventLevels(db, detail.event.id).catch(() => undefined);
    after(async () => {
      await emitMatchEvent(db, "match.result", code, { confirmed: viewer.isCreator });
    });
    revalidatePath(`/${code}`);
    revalidatePath("/me");
    return null;
  });
}
