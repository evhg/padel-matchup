"use server";

import { revalidatePath } from "next/cache";
import { getEventPhoto, removeEventPhoto, setEventPhoto } from "@/lib/domain/photos";
import { DomainError } from "@/lib/domain/errors";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, loadEvent, runA, type ActionResult } from "./shared";

/** The court photo behind the result: any participant adds it once; the uploader or the organiser can take it down. */
export async function addPhotoAction(code: string, dataUrl: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? "");
    if (!m) throw new DomainError("invalid", "mime");
    await setEventPhoto(db, { eventId: detail.event.id, playerId: me.id, mime: m[1], dataBase64: m[2] });
    revalidatePath(`/${code}`);
    revalidatePath(`/${code}/card`);
    return null;
  });
}

export async function removePhotoAction(code: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    if (!(await getEventPhoto(db, detail.event.id))) return null;
    await removeEventPhoto(db, detail.event.id, me.id);
    revalidatePath(`/${code}`);
    revalidatePath(`/${code}/card`);
    return null;
  });
}
