"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { setAnswerPublished } from "@/lib/listen/answers";
import { approveItem, markPostedManually, ownerTelegramId, saveDraft, skipItem, type ApproveOutcome } from "@/lib/listen/tick";
import { getSessionPlayer } from "@/lib/session";
import { ActionFailure, runA, type ActionResult } from "./shared";

/** The owner is whoever signed in with the Telegram account behind TELEGRAM_OWNER_ID. No other admin secret exists. */
export async function requireOwner() {
  const db = await getDb();
  const me = await getSessionPlayer(db);
  const owner = ownerTelegramId();
  if (!owner || !me || me.telegramId !== owner) throw new ActionFailure("forbidden");
  return { db, me };
}

export async function isOwner(): Promise<boolean> {
  try {
    await requireOwner();
    return true;
  } catch {
    return false;
  }
}

export async function approveListenAction(id: string, draft?: string): Promise<ActionResult<ApproveOutcome>> {
  return runA(async () => {
    const { db } = await requireOwner();
    if (draft != null) await saveDraft(db, id, draft);
    const res = await approveItem(db, id);
    revalidatePath("/admin/listen");
    return res;
  });
}

export async function skipListenAction(id: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db } = await requireOwner();
    await skipItem(db, id);
    revalidatePath("/admin/listen");
    return null;
  });
}

export async function saveListenDraftAction(id: string, draft: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db } = await requireOwner();
    await saveDraft(db, id, draft);
    revalidatePath("/admin/listen");
    return null;
  });
}

export async function markListenPostedAction(id: string, replyUrl: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db } = await requireOwner();
    await markPostedManually(db, id, replyUrl.trim() || null);
    revalidatePath("/admin/listen");
    return null;
  });
}

export async function setAnswerPublishedAction(id: string, on: boolean): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db } = await requireOwner();
    await setAnswerPublished(db, id, on);
    revalidatePath("/admin/listen");
    revalidatePath("/answers");
    return null;
  });
}

