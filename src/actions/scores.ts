"use server";

import { revalidatePath } from "next/cache";
import { saveMatchScore, saveTournamentStandings, type SetScore } from "@/lib/domain/scores";
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
    revalidatePath(`/${code}`);
    revalidatePath("/me");
    return null;
  });
}

export async function saveStandingsAction(code: string, standings: string[]): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const viewer = await getViewer(db, detail);
    await saveTournamentStandings(db, { eventId: detail.event.id, playerId: viewer.player?.id ?? null, isCreator: viewer.isCreator, standings });
    revalidatePath(`/${code}`);
    return null;
  });
}
