"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { getDb } from "@/db";
import { tell } from "@/lib/coach/notify";
import { baseUrl } from "@/lib/config";
import { recordFact } from "@/lib/domain/facts";
import { createGroupFromEvent, decideGroupRequest, deleteGroup, getGroupByCode, getGroupMember, handOverGroup, joinGroup, leaveGroup, removeGroupMember, updateGroup, weeklyGroupFromEvent, withdrawGroupRequest } from "@/lib/domain/groups";
import { ASK_NOTE_MAX } from "@/lib/domain/groupAccess";
import { LIMITS } from "@/lib/domain/ratelimit";
import { notifyGroupAskCapped, notifyGroupAskDecided } from "@/lib/notify";
import { getPlayer } from "@/lib/domain/players";
import { translatorFor } from "@/lib/email/templates";
import { isValidInviteCode } from "@/lib/codes";
import { suggestGroupName } from "@/lib/domain/groupNames";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, assertRate, loadEvent, requirePlayer, runA, type ActionResult } from "./shared";

async function loadGroup(code: string) {
  if (!isValidInviteCode(code)) throw new ActionFailure("not_found");
  const db = await getDb();
  const group = await getGroupByCode(db, code);
  if (!group) throw new ActionFailure("not_found");
  return { db, group };
}

/** "Turn this crew into a group" from a match page: creator or any participant. */
export async function createGroupFromEventAction(code: string, name?: string, weekly = false): Promise<ActionResult<{ code: string; name: string; created: boolean; recurDow: number | null; recurTime: string | null }>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const fallbackName = suggestGroupName(await getLocale(), detail.event.code);
    // "Same time next week?" gives the group the match's own weekly slot; the plain button leaves the rhythm to the admin.
    const made = weekly ? await weeklyGroupFromEvent(db, { eventId: detail.event.id, actorPlayerId: me.id, fallbackName }) : { group: await createGroupFromEvent(db, { eventId: detail.event.id, actorPlayerId: me.id, name, fallbackName }), created: !detail.event.groupId };
    revalidatePath(`/${code}`);
    revalidatePath(`/${code}/card`);
    revalidatePath("/me");
    return { code: made.group.code, name: made.group.name, created: made.created, recurDow: made.group.recurDow, recurTime: made.group.recurTime };
  });
}

/**
 * The group page's own door (`via: "self"`): one tap in, or, when the group asks to join, an ask
 * with an optional note that the admins hear about after the response. The outcome tells the
 * screen which of the two happened; the page itself then renders the state.
 */
export async function joinGroupAction(code: string, name?: string, note?: string): Promise<ActionResult<{ outcome: "joined" | "already" | "requested" | "pending" | "declined" | "skipped" }>> {
  return runA(async () => {
    const { db, group } = await loadGroup(code);
    const me = await requirePlayer(db, name);
    await assertRate(db, "join", me.id, LIMITS.joinsPerPlayerPerHour, "hour");
    const res = await joinGroup(db, group.id, me.id, "self", { note: note?.slice(0, ASK_NOTE_MAX * 4) ?? null });
    if (res.outcome === "requested") {
      const request = res.request;
      after(async () => {
        await recordFact(db, { kind: "group.asked", channel: "web", actorPlayerId: me.id, subject: { type: "group", id: group.id }, code: group.code });
        // At most LIMITS.groupAskNoticesPerGroupPerDay notices a day per group; past that the ask stands, unannounced.
        if (res.notify) await notifyGroupAskCapped(db, group, me, request.note);
      });
    }
    revalidatePath(`/g/${code}`);
    if (res.outcome === "joined") revalidatePath("/me");
    return { outcome: res.outcome };
  });
}

/** The asker takes their ask back. */
export async function withdrawGroupRequestAction(code: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, group } = await loadGroup(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await withdrawGroupRequest(db, group.id, me.id);
    revalidatePath(`/g/${code}`);
    return null;
  });
}

/** Admin only: approve (a member now, through `joinGroup` with `via: "admin"`) or decline. The person hears either way, after the response. */
export async function decideGroupRequestAction(code: string, requestId: string, approve: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const parsed = z.string().uuid().safeParse(requestId);
    if (!parsed.success) throw new ActionFailure("invalid");
    const { db, group } = await loadGroup(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const res = await decideGroupRequest(db, { groupId: group.id, requestId: parsed.data, approve, actorPlayerId: me.id });
    after(async () => {
      await recordFact(db, { kind: approve ? "group.ask_approved" : "group.ask_declined", channel: "web", actorPlayerId: me.id, subject: { type: "group", id: group.id }, code: group.code });
      if (res.player) await notifyGroupAskDecided(db, group, res.player, approve);
    });
    revalidatePath(`/g/${code}`);
    return null;
  });
}

export async function leaveGroupAction(code: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, group } = await loadGroup(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await leaveGroup(db, group.id, me.id);
    revalidatePath(`/g/${code}`);
    revalidatePath("/me");
    return null;
  });
}

export async function removeGroupMemberAction(code: string, playerId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, group } = await loadGroup(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await removeGroupMember(db, group.id, me.id, playerId);
    revalidatePath(`/g/${code}`);
    return null;
  });
}

/**
 * Admin only: the group goes to another member, and the old admin stays on as a member. The new
 * admin hears it through `tell()`, after the response, and the fact log keeps the hand-over.
 */
export async function handOverGroupAction(code: string, playerId: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const parsed = z.string().uuid().safeParse(playerId);
    if (!parsed.success) throw new ActionFailure("invalid");
    const to = parsed.data;
    const { db, group } = await loadGroup(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const handed = await handOverGroup(db, group.id, me.id, to);
    after(async () => {
      await recordFact(db, { kind: "group.handed_over", channel: "web", actorPlayerId: me.id, subject: { type: "group", id: handed.id }, code: handed.code, data: { to } });
      const admin = await getPlayer(db, to);
      if (!admin) return;
      const { t } = await translatorFor(admin.locale);
      const url = `${baseUrl()}/g/${handed.code}`;
      await tell(db, admin, t("group.handedOver", { from: me.displayName, name: handed.name }), { inline_keyboard: [[{ text: t("group.open"), url }]] }, { label: t("group.open") }).catch(() => undefined);
    });
    revalidatePath(`/g/${code}`);
    revalidatePath("/me");
    return null;
  });
}

const updateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  askToJoin: z.boolean().optional(),
  recurDow: z.number().int().min(0).max(6).nullable().optional(),
  recurTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  recurLeadDays: z.number().int().min(1).max(14).optional(),
});
export type UpdateGroupActionInput = z.infer<typeof updateSchema>;

/** Admin only: the group goes, its matches stay. */
export async function deleteGroupAction(code: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, group } = await loadGroup(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    await deleteGroup(db, group.id, me.id);
    revalidatePath(`/g/${code}`);
    revalidatePath("/me");
    return null;
  });
}

export async function updateGroupAction(code: string, raw: UpdateGroupActionInput): Promise<ActionResult<null>> {
  return runA(async () => {
    const patch = updateSchema.parse(raw);
    const { db, group } = await loadGroup(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const member = await getGroupMember(db, group.id, me.id);
    if (!member || member.role !== "admin") throw new ActionFailure("forbidden");
    await updateGroup(db, group.id, me.id, patch);
    revalidatePath(`/g/${code}`);
    return null;
  });
}
