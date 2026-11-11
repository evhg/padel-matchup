"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { confirmOptOut } from "@/lib/domain/optouts";

/** "Yes, stop all email" on the opt-out page: a post, so only a person's tap stops the email. Back to the same page, which then says done. */
export async function stopEmailAction(form: FormData): Promise<void> {
  const e = String(form.get("e") ?? "");
  const s = String(form.get("s") ?? "");
  await confirmOptOut(await getDb(), e, s);
  redirect(`/unsubscribe?e=${encodeURIComponent(e)}&s=${encodeURIComponent(s)}`);
}
