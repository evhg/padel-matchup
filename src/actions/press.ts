"use server";

import { revalidatePath } from "next/cache";
import { approveOutreach, createDraft, DeskError, saveOutreachDraft, skipOutreach, type SendOutcome } from "@/lib/outreach/desk";
import { getOutreach } from "@/lib/outreach/desk";
import { requireOwner } from "./listen";
import { ActionFailure, runA, type ActionResult } from "./shared";

/** The press desk actions: owner only, one tap sends. */
export async function sendPressAction(id: string, subject?: string, body?: string): Promise<ActionResult<SendOutcome>> {
  return runA(async () => {
    const { db } = await requireOwner();
    if (subject != null || body != null) await saveOutreachDraft(db, id, { subject, body }).catch(deskFail);
    const res = await approveOutreach(db, id);
    revalidatePath("/admin/press");
    return res;
  });
}

export async function skipPressAction(id: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db } = await requireOwner();
    await skipOutreach(db, id);
    revalidatePath("/admin/press");
    return null;
  });
}

export async function savePressDraftAction(id: string, subject: string, body: string): Promise<ActionResult<null>> {
  return runA(async () => {
    const { db } = await requireOwner();
    await saveOutreachDraft(db, id, { subject, body }).catch(deskFail);
    revalidatePath("/admin/press");
    return null;
  });
}

/** Start an answer to an inbound email by hand (the drafted one may be missing or wrong). */
export async function replyPressAction(inboundId: string, body: string): Promise<ActionResult<{ id: string }>> {
  return runA(async () => {
    const { db } = await requireOwner();
    const inbound = await getOutreach(db, inboundId);
    if (!inbound || inbound.kind !== "inbound") throw new ActionFailure("not_found");
    const subject = /^re:/i.test(inbound.subject) ? inbound.subject : `Re: ${inbound.subject}`;
    const row = await createDraft(db, { kind: "reply", moment: inbound.moment, to: inbound.counterpartEmail, name: inbound.counterpartName, org: inbound.org, subject, body, inReplyTo: inbound.messageId }).catch(deskFail);
    revalidatePath("/admin/press");
    return { id: row.id };
  });
}

function deskFail(e: unknown): never {
  if (e instanceof DeskError) throw new ActionFailure("generic");
  throw e;
}
