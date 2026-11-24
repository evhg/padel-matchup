"use server";

import { revalidatePath } from "next/cache";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { settleEventLevels } from "@/lib/domain/rating";
import { saveMatchScore, type SetScore } from "@/lib/domain/scores";
import { after } from "next/server";
import { getLocale } from "next-intl/server";
import { playersOfSeats } from "@/lib/seatProps";
import { getViewer, loadEvent, runA, type ActionResult } from "./shared";

/**
 * `teamA` names two seats of this match by their seat ids, never by player id: the score panel goes to
 * every viewer of a started match, so it carries seat ids only (src/lib/seatProps.ts). The players behind
 * them are found here, among this match's own seats.
 */
export async function saveScoreAction(code: string, sets: SetScore[], teamA?: string[]): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const viewer = await getViewer(db, detail);
    const seatsA = Array.isArray(teamA) && teamA.length === 2 && teamA.every((s) => typeof s === "string") ? teamA : null;
    const teamAPlayers = seatsA ? playersOfSeats(detail.roster, seatsA) : [];
    await saveMatchScore(db, {
      eventId: detail.event.id,
      playerId: viewer.player?.id ?? null,
      isCreator: viewer.isCreator,
      sets,
      teamA: teamAPlayers.length === 2 ? teamAPlayers : undefined,
      // The seats themselves too: a held place the pairs name plays while the line-up can be put right
      // (`playHeldLocked`), and a held place has no player yet for `teamA` to name.
      teamASeats: seatsA ?? undefined,
      locale: viewer.player?.locale ?? (await getLocale()),
    });
    // A confirmed score moves levels, and a later save of it (a correction) moves them again from the new score.
    await settleEventLevels(db, detail.event.id).catch(() => undefined);
    after(async () => {
      await emitMatchEvent(db, "match.result", code, { confirmed: viewer.isCreator });
    });
    revalidatePath(`/${code}`);
    revalidatePath("/me");
    return null;
  });
}
