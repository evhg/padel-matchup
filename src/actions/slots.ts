"use server";

import { revalidatePath } from "next/cache";
import { cleanSource, SOURCE_COOKIE } from "@/lib/source";
import { bumpMetric } from "@/lib/domain/metrics";
import { cookies } from "next/headers";
import { after } from "next/server";
import { getDb } from "@/db";
import { baseUrl, emailEnabled } from "@/lib/config";
import { getPlayer } from "@/lib/domain/players";
import { getEventDetail, getSlotByInviteCode } from "@/lib/domain/queries";
import {
  claimSlotPaid,
  confirmInvite,
  declineInvite,
  leaveEvent,
  removeFromSlot,
  reserveSlot,
  setSlotPaid,
  type ConfirmOutcome,
  type DeclineOutcome,
  type JoinOutcome,
} from "@/lib/domain/slots";
import { joinGroup } from "@/lib/domain/groups";
import { formatLevel } from "@/lib/domain/levels";
import { joinWithPolicy, wasComplete } from "@/lib/domain/joining";
import { afterJoin, afterLeave } from "@/lib/aftermath";
import { setPlayerLevel } from "@/lib/domain/rating";
import { decideJoinRequest, withdrawJoinRequest } from "@/lib/domain/requests";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { notifyCreator, notifyLineupChange, notifyPromotion, notifyRefill, notifyRemoved, notifyRequestDecided, sendCalendarInvite, sendInviteEmail } from "@/lib/notify";
import { inviteUrl } from "@/lib/share";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, assertRate, loadEvent, requireCreator, requirePlayer, runA, type ActionResult } from "./shared";
import { LIMITS } from "@/lib/domain/ratelimit";

/** Was the line-up complete before this mutation? Drives the "- COMPLETE" calendar update. */

export async function joinAction(code: string, name?: string, level?: number | null): Promise<ActionResult<{ outcome: JoinOutcome["outcome"] | "requested" }>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const before = wasComplete(detail);
    const me = await requirePlayer(db, name);
    await assertRate(db, "join", me.id, LIMITS.joinsPerPlayerPerHour, "hour");
    // A level given while joining is the player's declaration (ranged events ask for it once).
    const myLevel = level != null ? await setPlayerLevel(db, me.id, level) : me.level;
    const ev = detail.event;
    // The rules themselves live in the domain, because the web form is no longer the only door in.
    const decision = await joinWithPolicy(db, detail, me, myLevel);
    if (decision.kind === "level_required") throw new ActionFailure("level_required");
    if (decision.kind === "requested") {
      after(async () => {
        await notifyCreator(db, ev, "requested", myLevel != null ? `${me.displayName} (${formatLevel(myLevel)})` : me.displayName, me.id);
      });
      revalidatePath(`/${code}`);
      return { outcome: "requested" as const };
    }
    const res = decision.result;
    if (res.outcome === "joined" || res.outcome === "waitlisted") {
      // A join that started from a tagged link (an Instagram story, a poster) is counted per source.
      // This one stays here: it is the web's own cookie and means nothing on another channel.
      const source = cleanSource((await cookies()).get(SOURCE_COOKIE)?.value);
      if (source) await bumpMetric(db, `join_src_${source}`).catch(() => undefined);
      after(async () => {
        await afterJoin(db, res, me, { wasComplete: before, code, level: myLevel });
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
        await emitMatchEvent(db, "match.joined", code, { player: { name: player.displayName, level: player.level }, outcome: res.join?.outcome ?? "joined", approved: true });
        if (res.event.status === "full") await emitMatchEvent(db, "match.full", code);
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
      await afterLeave(db, res, me, { wasComplete: before, code });
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
      await notifyRefill(db, res.event.id);
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

/** The player says the money is sent. Nothing is settled by this — it puts the question to the organiser. */
export async function claimPaidAction(code: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("not_member");
    await claimSlotPaid(db, { eventId: detail.event.id, playerId: me.id });
    revalidatePath(`/${code}`);
    return null;
  });
}

/** The organiser says it arrived, or takes it back. The domain refuses anyone else. */
export async function setPaidAction(code: string, slotId: string, paid: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    await setSlotPaid(db, { eventId: detail.event.id, slotId, actorPlayerId: viewer.player?.id ?? "", paid });
    revalidatePath(`/${code}`);
    return null;
  });
}
