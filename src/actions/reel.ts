"use server";

import { revalidatePath } from "next/cache";
import { later } from "@/lib/alerts";
import { reelUploadUrl } from "@/lib/config";
import { askReelUpload, setReelLink, signUploadTicket } from "@/lib/domain/matchReel";
import { passportKeys } from "@/lib/domain/profile";
import { tellOwnerVideoHere } from "@/lib/reelNotice";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, loadEvent, runA, type ActionResult } from "./shared";

/**
 * "Choose the video": where this match's film goes and the ticket that lets this browser send it. The
 * film goes from the phone to the reel host in parts; nothing of it passes through Kicksmash.
 */
export async function askReelUploadAction(code: string): Promise<ActionResult<{ url: string; token: string; ticket: string }>> {
  return runA(async () => {
    const url = reelUploadUrl();
    const keys = passportKeys();
    if (!url || !keys) throw new ActionFailure("generic", "upload_off");
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const now = new Date();
    const { token } = await askReelUpload(db, { eventId: detail.event.id, playerId: me.id, now });
    revalidatePath(`/${code}`);
    return { url, token, ticket: await signUploadTicket(token, keys, now) };
  });
}

/** "Paste a link": the match keeps the link to the film on the player's drive, and the owner hears that a video is here. */
export async function setReelLinkAction(code: string, text: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await setReelLink(db, { eventId: detail.event.id, playerId: me.id, text });
    await later(() => tellOwnerVideoHere(detail.event.code, "link"));
    revalidatePath(`/${code}`);
    return null;
  });
}
