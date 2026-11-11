"use server";

import { revalidatePath } from "next/cache";
import { removeHighlights, setHighlights } from "@/lib/domain/highlights";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, loadEvent, runA, type ActionResult } from "./shared";

/** "Add the highlights video": anybody in the match pastes the YouTube link once the match has started. */
export async function setHighlightsAction(code: string, text: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await setHighlights(db, { eventId: detail.event.id, playerId: me.id, text: typeof text === "string" ? text.slice(0, 4000) : "" });
    revalidatePath(`/${code}`);
    return null;
  });
}

/** The person who added the link, or the organiser, takes it down. */
export async function removeHighlightsAction(code: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await removeHighlights(db, detail.event.id, me.id);
    revalidatePath(`/${code}`);
    return null;
  });
}
