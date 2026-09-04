"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getDb } from "@/db";
import { baseUrl, emailEnabled } from "@/lib/config";
import { getPlayer } from "@/lib/domain/players";
import { getEventDetail, getSlotByInviteCode } from "@/lib/domain/queries";
import {
  confirmInvite,
  declineInvite,
  joinEvent,
  leaveEvent,
  removeFromSlot,
  reserveSlot,
  type ConfirmOutcome,
  type DeclineOutcome,
  type JoinOutcome,
} from "@/lib/domain/slots";
import { lineupComplete } from "@/lib/lineup";
import { notifyCreator, notifyLineupChange, notifyPromotion, notifyRemoved, sendCalendarInvite, sendInviteEmail } from "@/lib/notify";
import { inviteUrl } from "@/lib/share";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, loadEvent, requireCreator, requirePlayer, runA, type ActionResult } from "./shared";

/** Was the line-up complete before this mutation? Drives the "- COMPLETE" calendar update. */
const wasComplete = (detail: { roster: { status: string; position: number }[]; event: { capacity: number } }) =>
  lineupComplete(detail.roster as Parameters<typeof lineupComplete>[0], detail.event.capacity);

export async function joinAction(code: string, name?: string): Promise<ActionResult<{ outcome: JoinOutcome["outcome"] }>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const before = wasComplete(detail);
    const me = await requirePlayer(db, name);
    const res = await joinEvent(db, { eventId: detail.event.id, playerId: me.id });
    if (res.outcome === "joined" || res.outcome === "waitlisted") {
      after(async () => {
        await notifyCreator(db, res.event, res.outcome === "joined" ? "joined" : "waitlisted", me.displayName, me.id);
        const fresh = await notifyLineupChange(db, res.event, before, me.id);
        if (res.outcome === "joined") await sendCalendarInvite(db, fresh ?? res.event, me);
      });
    }
    revalidatePath(`/${code}`);
    return { outcome: res.outcome };
  });
}

export async function leaveAction(code: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const before = wasComplete(detail);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("not_member");
    const res = await leaveEvent(db, { eventId: detail.event.id, playerId: me.id });
    after(async () => {
      if (!res.wasWaitlisted) await notifyCreator(db, res.event, "left", me.displayName, me.id);
      const fresh = await notifyLineupChange(db, res.event, before, res.promotion?.playerId);
      await notifyPromotion(db, fresh ?? res.event, res.promotion);
    });
    revalidatePath(`/${code}`);
    return null;
  });
}

export async function removeAction(code: string, slotId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    const before = wasComplete(detail);
    const res = await removeFromSlot(db, { eventId: detail.event.id, slotId, actorPlayerId: viewer.player?.id ?? null });
    after(async () => {
      await notifyRemoved(db, res.event, res.removedPlayerId);
      const fresh = await notifyLineupChange(db, res.event, before, res.promotion?.playerId);
      await notifyPromotion(db, fresh ?? res.event, res.promotion);
    });
    revalidatePath(`/${code}`);
    return null;
  });
}

export async function reserveAction(
  code: string,
  input: { name: string; email?: string; phone?: string; slotId?: string },
): Promise<ActionResult<{ inviteUrl: string; inviteCode: string; name: string; emailed: boolean }>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    const before = wasComplete(detail);
    const { slot, event } = await reserveSlot(db, {
      eventId: detail.event.id,
      actorPlayerId: viewer.player?.id ?? null,
      name: input.name,
      email: input.email,
      phone: input.phone,
      slotId: input.slotId,
    });
    const emailed = Boolean(slot.invitedEmail) && emailEnabled();
    after(async () => {
      // Reserving over a declined spot never completes a line-up, but it can un-complete one? No: declined ≠ occupied. Kept for symmetry.
      await notifyLineupChange(db, event, before);
      if (emailed) await sendInviteEmail(db, event, slot, detail.creator);
    });
    revalidatePath(`/${code}`);
    return { inviteUrl: inviteUrl(baseUrl(), code, slot.inviteCode!), inviteCode: slot.inviteCode!, name: slot.invitedName ?? input.name, emailed };
  });
}

export async function confirmInviteAction(
  code: string,
  inviteCode: string,
  input: { name?: string; email?: string },
): Promise<ActionResult<{ outcome: ConfirmOutcome["outcome"] }>> {
  return runA(async () => {
    const db = await getDb();
    const found = await getSlotByInviteCode(db, inviteCode);
    const before = found ? wasComplete(await getEventDetail(db, found.event)) : false;
    const me = await requirePlayer(db, input.name);
    const res = await confirmInvite(db, { inviteCode, playerId: me.id, email: input.email });
    if (res.outcome === "confirmed") {
      after(async () => {
        const fresh = (await getPlayer(db, me.id)) ?? me;
        await notifyCreator(db, res.event, "confirmed", fresh.displayName, fresh.id);
        const ev = await notifyLineupChange(db, res.event, before, fresh.id);
        await sendCalendarInvite(db, ev ?? res.event, fresh);
      });
    }
    revalidatePath(`/${code}`);
    revalidatePath(`/${code}/i/${inviteCode}`);
    return { outcome: res.outcome };
  });
}

export async function declineInviteAction(code: string, inviteCode: string): Promise<ActionResult<{ outcome: DeclineOutcome["outcome"] }>> {
  return runA(async () => {
    const db = await getDb();
    const found = await getSlotByInviteCode(db, inviteCode);
    const before = found ? wasComplete(await getEventDetail(db, found.event)) : false;
    const res = await declineInvite(db, { inviteCode });
    if (res.outcome === "declined") {
      const name = res.slot.invitedName ?? "";
      after(async () => {
        await notifyCreator(db, res.event, "declined", name, null);
        const fresh = await notifyLineupChange(db, res.event, before, res.promotion?.playerId);
        await notifyPromotion(db, fresh ?? res.event, res.promotion);
      });
    }
    revalidatePath(`/${code}`);
    revalidatePath(`/${code}/i/${inviteCode}`);
    return { outcome: res.outcome };
  });
}
