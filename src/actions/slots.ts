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
import { joinGroup } from "@/lib/domain/groups";
import { formatLevel, hasRange, levelFit } from "@/lib/domain/levels";
import { setPlayerLevel } from "@/lib/domain/rating";
import { createJoinRequest, decideJoinRequest, withdrawJoinRequest } from "@/lib/domain/requests";
import { lineupComplete } from "@/lib/lineup";
import { notifyCreator, notifyLineupChange, notifyPromotion, notifyRemoved, notifyRequestDecided, sendCalendarInvite, sendInviteEmail } from "@/lib/notify";
import { inviteUrl } from "@/lib/share";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, assertRate, loadEvent, requireCreator, requirePlayer, runA, type ActionResult } from "./shared";
import { LIMITS } from "@/lib/domain/ratelimit";

/** Was the line-up complete before this mutation? Drives the "- COMPLETE" calendar update. */
const wasComplete = (detail: { roster: { status: string; position: number }[]; event: { capacity: number } }) =>
  lineupComplete(detail.roster as Parameters<typeof lineupComplete>[0], detail.event.capacity);

export async function joinAction(code: string, name?: string, level?: number | null): Promise<ActionResult<{ outcome: JoinOutcome["outcome"] | "requested" }>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const before = wasComplete(detail);
    const me = await requirePlayer(db, name);
    await assertRate(db, "join", me.id, LIMITS.joinsPerPlayerPerHour, "hour");
    // A level given while joining is the player's declaration (ranged events ask for it once).
    const myLevel = level != null ? await setPlayerLevel(db, me.id, level) : me.level;
    const ev = detail.event;
    const range = { min: ev.levelMin, max: ev.levelMax };
    if (hasRange(range) && me.id !== ev.creatorPlayerId) {
      const fit = levelFit(range, myLevel);
      if (fit === "unknown") throw new ActionFailure("level_required");
      if (fit !== "ok") {
        const already = [...detail.roster, ...detail.waitlist].some((s) => s.playerId === me.id);
        if (already) return { outcome: "already_in" as const };
        await createJoinRequest(db, { eventId: ev.id, playerId: me.id, level: myLevel });
        after(async () => {
          await notifyCreator(db, ev, "requested", myLevel != null ? `${me.displayName} (${formatLevel(myLevel)})` : me.displayName, me.id);
        });
        revalidatePath(`/${code}`);
        return { outcome: "requested" as const };
      }
    }
    const res = await joinEvent(db, { eventId: detail.event.id, playerId: me.id });
    if (res.outcome === "joined" || res.outcome === "waitlisted") {
      // Joining a group's match makes you part of the group (so the next match pings you too).
      if (ev.groupId) await joinGroup(db, ev.groupId, me.id).catch(() => undefined);
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

export async function withdrawJoinRequestAction(code: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await withdrawJoinRequest(db, { eventId: detail.event.id, playerId: me.id });
    revalidatePath(`/${code}`);
    return null;
  });
}

/** Organizer approves (seats or waitlists the player) or declines a level-range request. */
export async function decideJoinRequestAction(code: string, requestId: string, approve: boolean): Promise<ActionResult<{ outcome: JoinOutcome["outcome"] | "declined" }>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    const before = wasComplete(detail);
    const res = await decideJoinRequest(db, { eventId: detail.event.id, requestId, approve, actorPlayerId: viewer.player?.id ?? null });
    const player = res.player;
    if (approve && player && detail.event.groupId) await joinGroup(db, detail.event.groupId, player.id).catch(() => undefined);
    after(async () => {
      if (!player) return;
      if (approve) {
        const fresh = await notifyLineupChange(db, res.event, before, player.id);
        if (res.join?.outcome === "joined") await notifyRequestDecided(db, fresh ?? res.event, player, true);
      } else {
        await notifyRequestDecided(db, res.event, player, false);
      }
    });
    revalidatePath(`/${code}`);
    return { outcome: approve ? (res.join?.outcome ?? "joined") : "declined" };
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
    await assertRate(db, "reserve", detail.event.creatorPlayerId, LIMITS.reservesPerOrganizerPerDay);
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
    if (res.outcome === "confirmed" && res.event.groupId) await joinGroup(db, res.event.groupId, me.id).catch(() => undefined);
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
