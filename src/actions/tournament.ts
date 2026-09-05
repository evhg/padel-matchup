"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { TournamentFormat } from "@/db/schema";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { applyEventLevels } from "@/lib/domain/rating";
import { deleteLastRound, generateRound, saveTournamentMatchScore, setTournamentLock, setTournamentSettings } from "@/lib/domain/tournament";
import { getViewer, loadEvent, requireCreator, runA, type ActionResult } from "./shared";

export async function setTournamentSettingsAction(code: string, input: { courts?: number | null; pointsPerMatch?: number | null; courtNames?: string[] | null; format?: TournamentFormat }): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    await setTournamentSettings(db, { eventId: detail.event.id, actorPlayerId: viewer.player?.id ?? null, ...input });
    revalidatePath(`/${code}`);
    return null;
  });
}

export async function generateRoundAction(code: string): Promise<ActionResult<{ roundNumber: number }>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    const round = await generateRound(db, { eventId: detail.event.id, actorPlayerId: viewer.player?.id ?? null });
    revalidatePath(`/${code}`);
    return { roundNumber: round.roundNumber };
  });
}

export async function deleteLastRoundAction(code: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await requireCreator(code);
    await deleteLastRound(db, { eventId: detail.event.id });
    revalidatePath(`/${code}`);
    return null;
  });
}

export async function saveTournamentMatchAction(code: string, matchId: string, sideA: number | null, sideB: number | null): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const viewer = await getViewer(db, detail);
    await saveTournamentMatchScore(db, { eventId: detail.event.id, matchId, sideA, sideB, playerId: viewer.player?.id ?? null, isCreator: viewer.isCreator });
    revalidatePath(`/${code}`);
    return null;
  });
}

export async function setTournamentLockAction(code: string, locked: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    await setTournamentLock(db, { eventId: detail.event.id, locked, actorPlayerId: viewer.player?.id ?? null });
    if (locked) await applyEventLevels(db, detail.event.id).catch(() => undefined);
    if (locked) {
      after(async () => {
        await emitMatchEvent(db, "match.result", code, { confirmed: true });
      });
    }
    revalidatePath(`/${code}`);
    revalidatePath("/me");
    return null;
  });
}
