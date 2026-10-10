"use server";

import { revalidatePath } from "next/cache";
import { countedSource, SOURCE_COOKIE } from "@/lib/source";
import { bumpMetric } from "@/lib/domain/metrics";
import { cookies } from "next/headers";
import { after } from "next/server";
import { getDb } from "@/db";
import { baseUrl, emailEnabled } from "@/lib/config";
import { getPlayer } from "@/lib/domain/players";
import { getEventDetail, getSlotByInviteCode } from "@/lib/domain/queries";
import { isClaimable } from "@/lib/domain/events";
import { namesFromChat, planPaste } from "@/lib/domain/pasteNames";
import {
  claimSlotPaid,
  confirmInvite,
  declineInvite,
  leaveEvent,
  promotedOf,
  removeFromSlot,
  reserveNames,
  reserveSlot,
  setSlotPaid,
  type ConfirmOutcome,
  type DeclineOutcome,
  type JoinOutcome,
} from "@/lib/domain/slots";
import { joinGroup } from "@/lib/domain/groups";
import { setCourtBooked } from "@/lib/domain/courtBooked";
import { formatLevel } from "@/lib/domain/levels";
import { joinWithPolicy, wasComplete } from "@/lib/domain/joining";
import { admission, hasRange } from "@/lib/domain/levels";
import { bePartner, pairSingles, splitPair } from "@/lib/domain/pairSeats";
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

/** `partnerName`: on a fixed-pairs night, the partner who signs up with the player; their name becomes a reserved spot with its own link. */
export async function joinAction(code: string, name?: string, level?: number | null, partnerName?: string | null): Promise<ActionResult<{ outcome: JoinOutcome["outcome"] | "requested"; partner?: { name: string; inviteUrl: string } }>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const before = wasComplete(detail);
    // Everybody already in it, held spots too: a new record that takes one of these names is counted (`newid_name_here`).
    const namesHere = [...detail.roster, ...detail.waitlist].filter((s) => s.status !== "empty" && s.status !== "declined").map((s) => s.player?.displayName ?? s.invitedName);
    const me = await requirePlayer(db, name, { namesHere });
    await assertRate(db, "join", me.id, LIMITS.joinsPerPlayerPerHour, "hour");
    // A level given while joining is the player's declaration (ranged events ask for it once).
    const myLevel = level != null ? await setPlayerLevel(db, me.id, level) : me.level;
    const ev = detail.event;
    // The rules themselves live in the domain, because the web form is no longer the only door in.
    const decision = await joinWithPolicy(db, detail, me, myLevel, partnerName);
    if (decision.kind === "level_required") throw new ActionFailure("level_required");
    if (decision.kind === "requested") {
      after(async () => {
        await notifyCreator(db, ev, "requested", myLevel != null ? `${me.displayName} (${formatLevel(myLevel)})` : me.displayName, me.id);
      });
      revalidatePath(`/${code}`);
      return { outcome: "requested" as const };
    }
    const res = decision.result;
    const partner = res.partner?.inviteCode ? { name: res.partner.invitedName ?? "", inviteUrl: inviteUrl(baseUrl(), code, res.partner.inviteCode) } : undefined;
    // A single who named their partner: the line-up changed by a reserved spot, as the organiser's reserve changes it.
    if (res.outcome === "already_in" && res.partner) after(async () => void (await notifyLineupChange(db, res.event, before)));
    if (res.outcome === "joined" || res.outcome === "waitlisted") {
      // A join that started from a tagged link (an Instagram story, a poster) is counted per source.
      // This one stays here: it is the web's own cookie and means nothing on another channel.
      const source = countedSource((await cookies()).get(SOURCE_COOKIE)?.value);
      if (source) await bumpMetric(db, `join_src_${source}`).catch(() => undefined);
      after(async () => {
        await afterJoin(db, res, me, { wasComplete: before, code, level: myLevel });
      });
    }
    revalidatePath(`/${code}`);
    return { outcome: res.outcome, partner };
  });
}

/**
 * "Be their partner" on a fixed-pairs night: the player takes the place beside a single on the list.
 * Somebody new is joined as any join is, with its notices (`afterJoin`); a ranged night holds them to
 * the range the way the Join button does, and an ask to join goes through that button.
 */
export async function bePartnerAction(code: string, slotId: string, name?: string): Promise<ActionResult<{ outcome: "paired" }>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const before = wasComplete(detail);
    const me = await requirePlayer(db, name);
    await assertRate(db, "join", me.id, LIMITS.joinsPerPlayerPerHour, "hour");
    const ev = detail.event;
    // Somebody already in (the organiser let them in) pairs without a second check of the range.
    const seated = [...detail.roster, ...detail.waitlist].some((s) => s.playerId === me.id);
    if (hasRange({ min: ev.levelMin, max: ev.levelMax }) && me.id !== ev.creatorPlayerId && !seated) {
      const fit = admission(ev, me);
      if (fit === "unknown") throw new ActionFailure("level_required");
      if (fit !== "ok") throw new ActionFailure("forbidden");
    }
    const res = await bePartner(db, { eventId: ev.id, playerId: me.id, slotId });
    if (res.joined && ev.groupId) await joinGroup(db, ev.groupId, me.id, "match").catch(() => undefined);
    after(async () => {
      if (res.joined) await afterJoin(db, { outcome: "joined", slot: res.slot, event: res.event }, me, { wasComplete: before, code, level: me.level });
      else await notifyLineupChange(db, res.event, before);
    });
    revalidatePath(`/${code}`);
    return { outcome: "paired" as const };
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
    // A seat approved by the organiser is a match seat (`via: "match"`): it makes a member of a group that lets anyone in, and of no group that asks to join.
    if (approve && player && detail.event.groupId) await joinGroup(db, detail.event.groupId, player.id, "match").catch(() => undefined);
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

/**
 * Leaving. On a fixed-pairs night a partner who is a player stays, as "Partner needed"; a partner who
 * is still only the name this player gave goes with them (`leaveEvent`), because nobody else holds
 * that link. Nobody takes out a player who joined by themselves.
 */
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

/** The organiser pairs two singles on a fixed-pairs night, before round 1. */
export async function pairSinglesAction(code: string, slotA: string, slotB: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    await pairSingles(db, { eventId: detail.event.id, slotIds: [slotA, slotB], actorPlayerId: viewer.player?.id ?? null });
    after(async () => void (await emitMatchEvent(db, "match.updated", code)));
    revalidatePath(`/${code}`);
    return null;
  });
}

/** The organiser splits a pair on a fixed-pairs night, before round 1: both partners read as singles. */
export async function splitPairAction(code: string, slotId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    await splitPair(db, { eventId: detail.event.id, slotId, actorPlayerId: viewer.player?.id ?? null });
    after(async () => void (await emitMatchEvent(db, "match.updated", code)));
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
      const fresh = await notifyLineupChange(db, res.event, before, promotedOf(res.promotion).map((p) => p.playerId));
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

/**
 * "Paste the names from the group" (src/components/PasteNames.tsx): the organiser's pasted chat, read
 * again here (`namesFromChat`), each name not already in the match held as a reserved spot, in one
 * request and one transaction (`reserveNames`): one rate check for the whole list against the same
 * daily limit every reserved spot counts towards, one line-up notice, one page render. Rule 12: a
 * list is one request, never one per name.
 */
export async function reserveManyAction(code: string, pasted: string): Promise<ActionResult<{ held: string[]; already: string[]; noSpot: string[] }>> {
  return runA(async () => {
    if (typeof pasted !== "string") throw new ActionFailure("invalid");
    const { db, detail, viewer } = await requireCreator(code);
    const namesHere = [...detail.roster, ...detail.waitlist].filter((s) => s.status !== "empty" && s.status !== "declined").map((s) => s.player?.displayName ?? s.invitedName ?? "").filter(Boolean);
    const plan = planPaste(namesFromChat(pasted.slice(0, 20000)), namesHere, detail.roster.filter(isClaimable).length);
    if (plan.hold.length === 0) return { held: [], already: plan.already, noSpot: plan.noSpot };
    await assertRate(db, "reserve", detail.event.creatorPlayerId, LIMITS.reservesPerOrganizerPerDay, "day", plan.hold.length);
    const before = wasComplete(detail);
    const { held, event } = await reserveNames(db, { eventId: detail.event.id, actorPlayerId: viewer.player?.id ?? null, names: plan.hold });
    after(async () => {
      await notifyLineupChange(db, event, before);
    });
    revalidatePath(`/${code}`);
    const names = held.map((s) => s.invitedName ?? "");
    return { held: names, already: plan.already, noSpot: [...plan.hold.slice(held.length), ...plan.noSpot] };
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
    // An organiser's invitation is to the match, not the crew: the same match door as any other seat.
    if (res.outcome === "confirmed" && res.event.groupId) await joinGroup(db, res.event.groupId, me.id, "match").catch(() => undefined);
    if (res.outcome === "confirmed") {
      // A fixed-pairs night's partner can claim a spot that waits with their pair: no "you're in" and no
      // invitation yet. The organiser hears that they wait, and the promotion sends the invitation.
      const listed = res.slot.position <= res.event.capacity;
      after(async () => {
        const fresh = (await getPlayer(db, me.id)) ?? me;
        await notifyCreator(db, res.event, listed ? "confirmed" : "waitlisted", fresh.displayName, fresh.id);
        if (!listed) return;
        const ev = await notifyLineupChange(db, res.event, before, fresh.id);
        await sendCalendarInvite(db, ev ?? res.event, fresh);
      });
    }
    // The named partner was in already: the reserved spot they leave can move the waiting list up.
    if (res.outcome === "already_in" && res.promotion) {
      const promotion = res.promotion;
      after(async () => {
        const fresh = await notifyLineupChange(db, res.event, before, promotedOf(promotion).map((p) => p.playerId));
        await notifyPromotion(db, fresh ?? res.event, promotion);
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
        const fresh = await notifyLineupChange(db, res.event, before, promotedOf(res.promotion).map((p) => p.playerId));
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

/**
 * "I booked it", or taken back: the organiser or a player in a seat (the domain refuses anyone else).
 * The player booked and paid in the club's own app; this only tells the others. The cards follow in
 * `after()`, edited in place (DECIDING rules 5 and 36).
 */
export async function setCourtBookedAction(code: string, booked: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("not_member");
    const changed = await setCourtBooked(db, detail, me.id, booked);
    if (changed) {
      after(async () => {
        await emitMatchEvent(db, "match.updated", code, { courtBooked: booked }, { channel: "web", actorPlayerId: me.id });
      });
    }
    revalidatePath(`/${code}`);
    return null;
  });
}
