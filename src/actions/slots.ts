"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { getPlayer } from "@/lib/domain/players";
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
import { notifyCreator, notifyPromotion, notifyRemoved, sendCalendarInvite } from "@/lib/notify";
import { inviteUrl } from "@/lib/share";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, loadEvent, requireCreator, requirePlayer, runA, type ActionResult } from "./shared";

export async function joinAction(code: string, name?: string): Promise<ActionResult<{ outcome: JoinOutcome["outcome"] }>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await requirePlayer(db, name);
    const res = await joinEvent(db, { eventId: detail.event.id, playerId: me.id });
    if (res.outcome === "joined" || res.outcome === "waitlisted") {
      after(async () => {
        await notifyCreator(db, res.event, res.outcome === "joined" ? "joined" : "waitlisted", me.displayName, me.id);
        if (res.outcome === "joined") await sendCalendarInvite(db, res.event, me);
      });
    }
    revalidatePath(`/${code}`);
    return { outcome: res.outcome };
  });
}

export async function leaveAction(code: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("not_member");
    const res = await leaveEvent(db, { eventId: detail.event.id, playerId: me.id });
    after(async () => {
      if (!res.wasWaitlisted) await notifyCreator(db, res.event, "left", me.displayName, me.id);
      await notifyPromotion(db, res.event, res.promotion);
    });
    revalidatePath(`/${code}`);
    return null;
  });
}

export async function removeAction(code: string, slotId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    const res = await removeFromSlot(db, { eventId: detail.event.id, slotId, actorPlayerId: viewer.player?.id ?? null });
    after(async () => {
      await notifyRemoved(db, res.event, res.removedPlayerId);
      await notifyPromotion(db, res.event, res.promotion);
    });
    revalidatePath(`/${code}`);
    return null;
  });
}

export async function reserveAction(
  code: string,
  input: { name: string; email?: string; phone?: string; slotId?: string },
): Promise<ActionResult<{ inviteUrl: string; inviteCode: string; name: string }>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    const { slot } = await reserveSlot(db, {
      eventId: detail.event.id,
      actorPlayerId: viewer.player?.id ?? null,
      name: input.name,
      email: input.email,
      phone: input.phone,
      slotId: input.slotId,
    });
    revalidatePath(`/${code}`);
    return { inviteUrl: inviteUrl(baseUrl(), code, slot.inviteCode!), inviteCode: slot.inviteCode!, name: slot.invitedName ?? input.name };
  });
}

export async function confirmInviteAction(
  code: string,
  inviteCode: string,
  input: { name?: string; email?: string },
): Promise<ActionResult<{ outcome: ConfirmOutcome["outcome"] }>> {
  return runA(async () => {
    const db = await getDb();
    const me = await requirePlayer(db, input.name);
    const res = await confirmInvite(db, { inviteCode, playerId: me.id, email: input.email });
    if (res.outcome === "confirmed") {
      after(async () => {
        const fresh = (await getPlayer(db, me.id)) ?? me;
        await notifyCreator(db, res.event, "confirmed", fresh.displayName, fresh.id);
        await sendCalendarInvite(db, res.event, fresh);
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
    const res = await declineInvite(db, { inviteCode });
    if (res.outcome === "declined") {
      const name = res.slot.invitedName ?? "";
      after(async () => {
        await notifyCreator(db, res.event, "declined", name, null);
        await notifyPromotion(db, res.event, res.promotion);
      });
    }
    revalidatePath(`/${code}`);
    revalidatePath(`/${code}/i/${inviteCode}`);
    return { outcome: res.outcome };
  });
}
