"use server";

import { isSeated } from "@/lib/domain/events";
import { LIMITS } from "@/lib/domain/ratelimit";
import { sendCalendarInvite } from "@/lib/notify";
import { ActionFailure, assertRate, getViewer, loadEvent, nameOnly, runA, type ActionResult } from "./shared";

/** "Not in your calendar? Send it again": the same invite, to the address on file. Seated players only, never a session by name, a few times a day; says so when the mail did not go. */
export async function resendCalendarInviteAction(code: string): Promise<ActionResult<{ email: string }>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const { player: me } = await getViewer(db, detail);
    // Every invitation carries the personal link (src/lib/notify.ts), and a session by name that proved
    // nothing may not have it mailed (DECIDING rule 34). Until 15 October 2026 this door did not ask.
    if (await nameOnly(me)) throw new ActionFailure("forbidden");
    if (!me?.email || !isSeated({ roster: detail.roster }, me.id) || detail.event.status === "cancelled") throw new ActionFailure("forbidden");
    await assertRate(db, "invite_resend", me.id, LIMITS.inviteResendsPerPlayerPerDay);
    const sent = await sendCalendarInvite(db, detail.event, me, "joined", detail);
    if (!sent) throw new ActionFailure("generic");
    return { email: me.email };
  });
}
