"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { cleanNoticeSettings } from "@/lib/domain/noticeKinds";
import { markInboxRead, saveNoticeSettings } from "@/lib/domain/notices";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, runA, type ActionResult } from "./shared";

/**
 * The player's own notice settings (the owner's decision D): a switch for each kind, quiet hours,
 * and the zone their browser named, which is the only place the app learns a player's own zone.
 * Private: no public shape, no API, no MCP tool carries them.
 */
export async function saveNoticeSettingsAction(input: { on: string[]; quietFrom: string; quietTo: string; tz: string }): Promise<ActionResult<null>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await saveNoticeSettings(db, me.id, cleanNoticeSettings({ on: Array.isArray(input?.on) ? input.on.map(String) : [], quietFrom: input?.quietFrom, quietTo: input?.quietTo, tz: input?.tz }));
    revalidatePath("/me");
    return null;
  });
}

/** Opening the inbox reads it: every notice is marked read, and the count beside My matches goes. */
export async function markNoticesReadAction(): Promise<ActionResult<number>> {
  return runA(async () => {
    const db = await getDb();
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const n = await markInboxRead(db, me.id);
    if (n > 0) revalidatePath("/", "layout");
    return n;
  });
}
