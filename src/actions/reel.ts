"use server";

import { revalidatePath } from "next/cache";
import { later } from "@/lib/alerts";
import { passportKeys, reelUploadUrl } from "@/lib/config";
import { askReelUpload, namesUpload, setReelLink, signUploadTicket, type SendWay } from "@/lib/domain/matchReel";
import { tellOwnerVideoHere } from "@/lib/reelNotice";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, loadEvent, runA, type ActionResult } from "./shared";

/**
 * "Choose the video": where this match's film goes and the ticket that lets this browser send it. The
 * film goes from the phone to the reel host in parts; nothing of it passes through Kicksmash.
 */
export async function askReelUploadAction(code: string, way: SendWay = "upload", again = false): Promise<ActionResult<{ url: string; token: string; ticket: string }>> {
  return runA(async () => {
    const url = reelUploadUrl();
    const keys = passportKeys();
    if (!url || !keys) throw new ActionFailure("generic", "upload_off");
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const now = new Date();
    const { token } = await askReelUpload(db, { eventId: detail.event.id, playerId: me.id, way: way === "clips" ? "clips" : "upload", again: again === true, now });
    revalidatePath(`/${code}`);
    return { url, token, ticket: await signUploadTicket(token, keys, now) };
  });
}

/** "Paste a link": the match keeps the link to the film on the player's drive, and the owner hears that a video is here. */
export async function setReelLinkAction(code: string, text: string, again = false): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await setReelLink(db, { eventId: detail.event.id, playerId: me.id, text, again: again === true });
    await later(() => tellOwnerVideoHere(detail.event.code, "link"));
    revalidatePath(`/${code}`);
    return null;
  });
}

/**
 * "Who is who?": the ticket that lets this browser send the players' names to the reel host, for the question the
 * fast reel's job asks of this match (`namesUpload`). The answer goes from the phone to the reel host, and the job
 * goes on from there.
 */
export async function namesTicketAction(code: string): Promise<ActionResult<{ url: string; upload: string; ticket: string }>> {
  return runA(async () => {
    const url = reelUploadUrl();
    const keys = passportKeys();
    if (!url || !keys) throw new ActionFailure("generic", "upload_off");
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const asked = await namesUpload(db, { eventId: detail.event.id, playerId: me.id });
    if (!asked) throw new ActionFailure("generic", "not_asked");
    return { url, upload: asked.upload, ticket: await signUploadTicket(asked.upload, keys, new Date()) };
  });
}
