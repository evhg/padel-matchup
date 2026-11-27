"use server";

import { revalidatePath } from "next/cache";
import { later } from "@/lib/alerts";
import { passportKeys, reelUploadUrl } from "@/lib/config";
import { askReelUpload, namesUpload, reelFetchFailed, setReelLink, signUploadTicket, type SendWay } from "@/lib/domain/matchReel";
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

/**
 * "Paste a link": the match keeps the link to the film on the player's drive. A Google Drive file goes to the reel host,
 * which fetches it to the store and starts the reel as for an upload, with the bar from the first minute (`setReelLink`).
 * Any other link, or a reel host that does not answer, is a video that is here, and the owner hears it.
 */
export async function setReelLinkAction(code: string, text: string, again = false): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const host = reelUploadUrl();
    const keys = passportKeys();
    const got = await setReelLink(db, { eventId: detail.event.id, playerId: me.id, text, again: again === true, fetch: Boolean(host && keys) });
    const asked = got.fetch && host && keys ? await askHostToFetch(host, got.fetch, keys) : false;
    if (got.fetch && !asked) await reelFetchFailed(db, got.fetch.token);
    if (!got.fetch) await later(() => tellOwnerVideoHere(detail.event.code, "link"));
    revalidatePath(`/${code}`);
    return null;
  });
}

/** The reel host takes the link's Drive file (`POST /u/<token>/link` in serve.py); false when it did not answer yes. */
async function askHostToFetch(host: string, link: { token: string; file: string }, keys: { priv: string; pub: string }): Promise<boolean> {
  try {
    const ticket = await signUploadTicket(link.token, keys, new Date());
    const res = await fetch(`${host}/u/${link.token}/link`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}`, "content-type": "application/json" },
      body: JSON.stringify({ file: link.file }),
      signal: AbortSignal.timeout(20_000),
    });
    return res.ok;
  } catch {
    return false;
  }
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
