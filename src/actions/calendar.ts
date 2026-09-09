"use server";

import { isOccupied } from "@/lib/domain/events";
import { LIMITS } from "@/lib/domain/ratelimit";
import { sendCalendarInvite } from "@/lib/notify";
import { ActionFailure, assertRate, getViewer, loadEvent, runA, type ActionResult } from "./shared";

/** "Not in your calendar? Send it again": the same invite, to the address on file. Seated players only, a few times a day. */
export async function resendCalendarInviteAction(code: string): Promise<ActionResult<{ email: string }>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const { player: me } = await getViewer(db, detail);
    const seated = Boolean(me && detail.roster.some((s) => s.playerId === me.id && isOccupied(s)));
    if (!me?.email || !seated || detail.event.status === "cancelled") throw new ActionFailure("forbidden");
    await assertRate(db, "invite_resend", me.id, LIMITS.inviteResendsPerPlayerPerDay);
    await sendCalendarInvite(db, detail.event, me);
    return { email: me.email };
  });
}
