"use server";

import { revalidatePath } from "next/cache";
import { countedSource, SOURCE_COOKIE } from "@/lib/source";
import { bumpMetric } from "@/lib/domain/metrics";
import { cookies } from "next/headers";
import { after } from "next/server";
import { getDb } from "@/db";
import { baseUrl, emailEnabled } from "@/lib/config";
import { getEventDetail, getSlotByInviteCode } from "@/lib/domain/queries";
import { isClaimable } from "@/lib/domain/events";
import { namesFromChat, planPaste } from "@/lib/domain/pasteNames";
import {
  claimSlotPaid,
  confirmInvite,
  declineInvite,
  hasLifeOutside,
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
import { joinWithPolicy, partnerAdmission, wasComplete } from "@/lib/domain/joining";
import { bePartner, pairSingles, splitPair } from "@/lib/domain/pairSeats";
import { afterConfirm, afterJoin, afterLeave, afterRelease } from "@/lib/aftermath";
import { decideHeldByName, seatedNamed, takeHeldByName, whoJoins } from "@/lib/domain/heldByName";
import { later } from "@/lib/alerts";
import { setPlayerLevel } from "@/lib/domain/rating";
import { decideJoinRequest, withdrawJoinRequest } from "@/lib/domain/requests";
import { emitMatchEvent } from "@/lib/api/webhooks";
import { notifyCreator, notifyLineupChange, notifyPromotion, notifyRefill, notifyRemoved, notifyRequestDecided, sendInviteEmail } from "@/lib/notify";
import { inviteUrl } from "@/lib/share";
import { getSessionPlayer, markSignedInByName, setSessionPlayer } from "@/lib/session";
import { attachHeldRecord, decideHeldLink, heldRecordsFor, pastPlayerRows, recordForAnswer, takeHeldLink } from "@/lib/domain/heldRecord";
import { answerOfPick, cleanPicks } from "@/lib/domain/pastAsk";
import { countSignIn } from "@/lib/domain/signins";
import { getPlayer } from "@/lib/domain/players";
import { DomainError } from "@/lib/domain/errors";
import { ActionFailure, assertRate, clientKey, loadEvent, requireCreator, requirePlayer, runA, type ActionResult } from "./shared";
import { LIMITS } from "@/lib/domain/ratelimit";
import { mergesLater } from "@/lib/mergeCount";
import { stayUpdated } from "@/lib/domain/stayUpdated";
import { stayChannels } from "@/lib/calendarFeed";

/** Was the line-up complete before this mutation? Drives the "- COMPLETE" calendar update. */

/** `partnerName`: on a fixed-pairs night, the partner who signs up with the player; their name becomes a reserved spot with its own link. */
/**
 * The plain join on the web. `o.differentPerson`: the person tapped "I'm a different Danny" under "Danny
 * is in this match. Sign in as Danny?" (the owner's decision of 15 October 2026), so a typed name that a
 * seated record carries joins as typed; nothing else sets it.
 */
export async function joinAction(code: string, name?: string, level?: number | null, partnerName?: string | null, o: { differentPerson?: boolean } = {}): Promise<ActionResult<{ outcome: JoinOutcome["outcome"] | "requested"; partner?: { name: string; inviteUrl: string } }>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const before = wasComplete(detail);
    // Everybody already in it, held spots too: a new record that takes one of these names is counted (`newid_name_here`).
    const namesHere = [...detail.roster, ...detail.waitlist].filter((s) => s.status !== "empty" && s.status !== "declined").map((s) => s.player?.displayName ?? s.invitedName);
    // A held place this name may take (DECIDING rule 34): a join would seat a second record of the name
    // beside it, a seat or a waiting place, and the place could never be taken by name after that. The
    // page offers "Take Danny's held place" instead; this refuses the join, whatever the page showed,
    // before any record is made (`whoJoins`).
    // So is the plain join of the name of a place that keeps a past player's record, from a browser that
    // knows nobody: it would make a second Danny beside his place (`hasLifeOutside`, only for such a name).
    // And the typed name of a record that holds a seat or a waiting place here, from a browser that knows
    // nobody: "Danny is in this match. Sign in as Danny?" first, unless the person said they are a
    // different Danny (`seatedNamed`, the owner's decision of 15 October 2026). Each counted, with no name.
    const different = o.differentPerson === true;
    const known = await getSessionPlayer(db);
    // "I'm a different Danny" beside a seated Danny: counted before the record is made, so the owner sees how often the question meets a real namesake.
    if (different && !known && seatedNamed([...detail.roster, ...detail.waitlist], null, name)) await bumpMetric(db, "join_name_different").catch(() => undefined);
    const who = await whoJoins(detail, known, name, new Date(), () => requirePlayer(db, name, { namesHere }), { keepsRecord: (id) => hasLifeOutside(db, id, detail.event.id), different });
    if ("held" in who) throw new ActionFailure("name_held");
    if ("seated" in who) {
      await bumpMetric(db, "join_name_seated").catch(() => undefined);
      throw new ActionFailure("name_seated");
    }
    const me = who.player;
    await assertRate(db, "join", me.id, LIMITS.joinsPerPlayerPerHour, "hour");
    // A level given while joining is the player's declaration (ranged events ask for it once).
    const myLevel = level != null ? await setPlayerLevel(db, me.id, level) : me.level;
    const ev = detail.event;
    // The rules themselves live in the domain, because the web form is no longer the only door in.
    const decision = await joinWithPolicy(db, detail, me, myLevel, partnerName);
    // `whoJoins` asked this before any record was made; the shared rule asks again for every door.
    if (decision.kind === "name_held") throw new ActionFailure("name_held");
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
        // The page now shows "Stay updated" asking for a channel (src/lib/domain/stayUpdated.ts): counted
        // once for the join, never for a view of the page (docs/OPERATING.md; rule 12).
        if (stayUpdated(me, stayChannels()).kind === "ask") await bumpMetric(db, "stay_asked").catch(() => undefined);
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
    const gate = await partnerAdmission(db, ev, me, seated);
    if (gate !== "ok") throw new ActionFailure(gate);
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

/**
 * The organiser holds a spot for a name. `pick`: the name came from "Played with you" (`true`), or the
 * organiser answered "Yes, that's Danny" to the typed name's question with the day and the club it was
 * shown; the place then keeps that past player's record (the owner, 11 October 2026: "Yes, keep the
 * record"; 12 October 2026: "if manually typed and it matches a previously played person it should ask").
 * The browser sends the name and the answer, never a player id: the record is found again here, among
 * the organiser's own past players (`recordForAnswer`), and with none, or with an answer that names
 * nobody there, the place is held by name only.
 */
export async function reserveAction(
  code: string,
  input: { name: string; email?: string; phone?: string; slotId?: string; pick?: boolean | { day: string; club: string | null } },
): Promise<ActionResult<{ inviteUrl: string; inviteCode: string; name: string; emailed: boolean }>> {
  return runA(async () => {
    const { db, detail, viewer } = await requireCreator(code);
    await assertRate(db, "reserve", detail.event.creatorPlayerId, LIMITS.reservesPerOrganizerPerDay);
    const before = wasComplete(detail);
    const [pick] = typeof input.name !== "string" ? [] : input.pick === true ? [{ name: input.name }] : input.pick && typeof input.pick === "object" ? cleanPicks([{ ...input.pick, name: input.name }]) : [];
    const record = pick ? recordForAnswer(await pastPlayerRows(db, detail.event.creatorPlayerId, new Date()), pick.name, answerOfPick(pick)) : null;
    const { slot, event } = await reserveSlot(db, {
      eventId: detail.event.id,
      actorPlayerId: viewer.player?.id ?? null,
      name: input.name,
      email: input.email,
      phone: input.phone,
      slotId: input.slotId,
      playerId: record?.id ?? null,
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
export async function reserveManyAction(code: string, pasted: string, picks?: unknown): Promise<ActionResult<{ held: string[]; already: string[]; noSpot: string[] }>> {
  return runA(async () => {
    if (typeof pasted !== "string") throw new ActionFailure("invalid");
    const { db, detail, viewer } = await requireCreator(code);
    const namesHere = [...detail.roster, ...detail.waitlist].filter((s) => s.status !== "empty" && s.status !== "declined").map((s) => s.player?.displayName ?? s.invitedName ?? "").filter(Boolean);
    const plan = planPaste(namesFromChat(pasted.slice(0, 20000)), namesHere, detail.roster.filter(isClaimable).length);
    if (plan.hold.length === 0) return { held: [], already: plan.already, noSpot: plan.noSpot };
    await assertRate(db, "reserve", detail.event.creatorPlayerId, LIMITS.reservesPerOrganizerPerDay, "day", plan.hold.length);
    const before = wasComplete(detail);
    // A name the organiser answered "Yes, that's Danny" for keeps that record, found again among the organiser's own past players.
    const answers = cleanPicks(picks);
    const records = answers.length ? heldRecordsFor(await pastPlayerRows(db, detail.event.creatorPlayerId, new Date()), plan.hold, answers) : undefined;
    const { held, event } = await reserveNames(db, { eventId: detail.event.id, actorPlayerId: viewer.player?.id ?? null, names: plan.hold, records });
    after(async () => {
      await notifyLineupChange(db, event, before);
    });
    revalidatePath(`/${code}`);
    const names = held.map((s) => s.invitedName ?? "");
    return { held: names, already: plan.already, noSpot: [...plan.hold.slice(held.length), ...plan.noSpot] };
  });
}

/**
 * "Keep Danny's matches": a place already held by name takes the record of the one past player of that
 * name (`attachHeldRecord`), so the personal link signs Danny in as the record he played under.
 */
export async function attachHeldRecordAction(code: string, slotId: string): Promise<ActionResult<{ name: string }>> {
  return runA(async () => {
    if (typeof slotId !== "string" || !/^[0-9a-f-]{36}$/i.test(slotId)) throw new ActionFailure("invalid");
    const { db, detail } = await requireCreator(code);
    const done = await attachHeldRecord(db, { eventId: detail.event.id, slotId, organiserId: detail.event.creatorPlayerId });
    revalidatePath(`/${code}`);
    return done;
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
    // A place that keeps a past player's record, opened in a browser that knows nobody (the owner, 11
    // October 2026): the link signs that browser in as the record, inside the "That's me" limits, and
    // makes no new record. A record outside them (an email, a Telegram and so on) proves who it is
    // first; the page says how. The session is marked by name: the link travels in group chats, so it
    // proves nothing. The email field is not offered here, and an email sent anyway is not kept.
    const viewer = await getSessionPlayer(db);
    if (!viewer && found) {
      const d = await decideHeldLink(db, { inviteCode, rateKey: await clientKey() });
      if (d) {
        if (!d.ok) throw d.reason === "too_many" ? new ActionFailure("too_many") : new DomainError("forbidden", "held_record");
        const res = await takeHeldLink(db, d);
        if (res.outcome === "confirmed") {
          await setSessionPlayer(d.playerId);
          await markSignedInByName(d.playerId);
          await later(() => countSignIn(db, "held_link"));
          if (res.event.groupId) await joinGroup(db, res.event.groupId, d.playerId, "match").catch(() => undefined);
          const record = await getPlayer(db, d.playerId);
          if (record) after(async () => void (await afterConfirm(db, res, record, { wasComplete: before })));
        }
        revalidatePath(`/${code}`);
        revalidatePath(`/${code}/i/${inviteCode}`);
        return { outcome: res.outcome };
      }
    }
    const me = viewer ?? (await requirePlayer(db, input.name));
    const res = await confirmInvite(db, { inviteCode, playerId: me.id, email: input.email, counter: mergesLater(db) });
    // An organiser's invitation is to the match, not the crew: the same match door as any other seat.
    if (res.outcome === "confirmed" && res.event.groupId) await joinGroup(db, res.event.groupId, me.id, "match").catch(() => undefined);
    // A fixed-pairs night's partner can claim a spot that waits with their pair: no "you're in" and no
    // invitation yet. The organiser hears that they wait, and the promotion sends the invitation.
    if (res.outcome === "confirmed") after(async () => void (await afterConfirm(db, res, me, { wasComplete: before })));
    // In already by another door: the reserved spot went the way a leave goes, and the match hears it
    // as it hears a leave. A fixed-pairs night that moved nobody up changed only its pairs.
    if (res.outcome === "already_in" && (res.promotion || !res.event.fixedPairs)) after(async () => void (await afterRelease(db, res, { wasComplete: before })));
    revalidatePath(`/${code}`);
    revalidatePath(`/${code}/i/${inviteCode}`);
    return { outcome: res.outcome };
  });
}

/**
 * "Take Danny's held place" on the plain match link (DECIDING rule 34, the owner, 11 October 2026):
 * the second of two taps. The rule decides before anything is made (`decideHeldByName`: the
 * address's rate, the same as "That's me", then every limit); a browser that knows nobody then gets
 * an ordinary new record carrying the held name (`requirePlayer`, with its own limit per address),
 * and the place is filled by the personal link's own write under the match's lock, the rule asked
 * once more (`takeHeldByName`). The organiser hears "Danny confirmed", as from the personal link.
 * The session is not marked as signed in by name: a record made here has no history to hold back.
 */
export async function takeHeldPlaceAction(code: string, name: string): Promise<ActionResult<{ outcome: "confirmed" }>> {
  return runA(async () => {
    if (typeof code !== "string" || typeof name !== "string" || !name.trim() || name.length > 80) throw new ActionFailure("invalid");
    const db = await getDb();
    const viewer = await getSessionPlayer(db);
    const d = await decideHeldByName(db, { code, name, viewer: viewer ? { id: viewer.id, name: viewer.displayName } : null, rateKey: await clientKey() });
    if (!d.ok) throw new ActionFailure(d.reason === "too_many" ? "too_many" : "invalid");
    const me = viewer ?? (await requirePlayer(db, d.name));
    const res = await takeHeldByName(db, d, { id: me.id, name: me.displayName });
    if (!res.ok) throw new ActionFailure("invalid");
    if (res.event.groupId) await joinGroup(db, res.event.groupId, me.id, "match").catch(() => undefined);
    await later(() => bumpMetric(db, "held_by_name"));
    after(async () => void (await afterConfirm(db, res, me, { wasComplete: res.wasComplete })));
    revalidatePath(`/${code}`);
    return { outcome: "confirmed" as const };
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
