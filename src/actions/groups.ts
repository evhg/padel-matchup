"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { getDb } from "@/db";
import { createGroupFromEvent, getGroupByCode, getGroupMember, joinGroup, leaveGroup, removeGroupMember, updateGroup } from "@/lib/domain/groups";
import { isValidInviteCode } from "@/lib/codes";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, loadEvent, requirePlayer, runA, type ActionResult } from "./shared";

async function loadGroup(code: string) {
  if (!isValidInviteCode(code)) throw new ActionFailure("not_found");
  const db = await getDb();
  const group = await getGroupByCode(db, code);
  if (!group) throw new ActionFailure("not_found");
  return { db, group };
}

/** "Turn this crew into a group" from a match page: creator or any participant. */
export async function createGroupFromEventAction(code: string, name?: string): Promise<ActionResult<{ code: string }>> {
  return runA(async () => {
    const { db, detail } = await loadEvent(code);
    const me = await getSessionPlayer(db);
    if (!me) throw new ActionFailure("no_identity");
    const t = await getTranslations();
    const group = await createGroupFromEvent(db, { eventId: detail.event.id, actorPlayerId: me.id, name, fallbackName: detail.event.venueName ?? t("group.fallbackName") });
    revalidatePath(`/${code}`);
    revalidatePath("/me");
    return { code: group.code };
  });
}

export async function joinGroupAction(code: string, name?: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db, group } = await loadGroup(code);
    const me = await requirePlayer(db, name);
    await joinGroup(db, group.id, me.id);
    revalidatePath(`/g/${code}`);
    revalidatePath("/me");
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

const updateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  recurDow: z.number().int().min(0).max(6).nullable().optional(),
  recurTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  recurLeadDays: z.number().int().min(1).max(14).optional(),
});
export type UpdateGroupActionInput = z.infer<typeof updateSchema>;

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
