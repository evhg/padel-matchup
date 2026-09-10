"use server";

import { isSeated } from "@/lib/domain/events";
import { LIMITS } from "@/lib/domain/ratelimit";
import { sendCalendarInvite } from "@/lib/notify";
import { ActionFailure, assertRate, getViewer, loadEvent, runA, type ActionResult } from "./shared";

/** "Not in your calendar? Send it again": the same invite, to the address on file. Seated players only, a few times a day; says so when the mail did not go. */
export async function resendCalendarInviteAction(code: string): Promise<ActionResult<{ email: string }>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const { player: me } = await getViewer(db, detail);
    if (!me?.email || !isSeated(detail, me.id) || detail.event.status === "cancelled") throw new ActionFailure("forbidden");
    await assertRate(db, "invite_resend", me.id, LIMITS.inviteResendsPerPlayerPerDay);
    const sent = await sendCalendarInvite(db, detail.event, me, "joined", detail);
    if (!sent) throw new ActionFailure("generic");
    return { email: me.email };
  });
}
