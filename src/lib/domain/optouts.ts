import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { emailOptOuts } from "@/db/schema";
import { sessionSecret } from "@/lib/env";
import { normalizeEmail } from "./players";

/** Organizer-initiated emails (invites, reminders) respect this list; a player adding their own email lifts it. */
export async function isOptedOut(db: Db, email: string | null | undefined): Promise<boolean> {
  const e = normalizeEmail(email);
  if (!e) return false;
  const [row] = await db.select({ email: emailOptOuts.email }).from(emailOptOuts).where(eq(emailOptOuts.email, e)).limit(1);
  return Boolean(row);
}

export async function addOptOut(db: Db, email: string): Promise<void> {
  const e = normalizeEmail(email);
  if (!e) return;
  await db.insert(emailOptOuts).values({ email: e }).onConflictDoNothing();
}

export async function removeOptOut(db: Db, email: string | null | undefined): Promise<void> {
  const e = normalizeEmail(email);
  if (!e) return;
  await db.delete(emailOptOuts).where(eq(emailOptOuts.email, e));
}

/** Short signature so an unsubscribe link can't be forged for someone else's address. */
export function optOutSignature(email: string): string {
  return createHmac("sha256", sessionSecret()).update(`optout:${normalizeEmail(email) ?? ""}`).digest("base64url").slice(0, 20);
}

export const optOutPath = (email: string) => `/unsubscribe?e=${encodeURIComponent(normalizeEmail(email) ?? "")}&s=${optOutSignature(email)}`;

/**
 * What the opt-out page shows for a link, without writing anything: a bad link, the question, or done.
 * Opening the link changes nothing, because a mail scanner (Safe Links and its kind) opens every link
 * in a mail, and the page used to stop all email to that person on the scanner's visit. The person
 * says yes with a button that posts (`stopEmailAction`), the same promise `notify.ts` keeps for "I'm in".
 */
export async function optOutState(db: Db, e: string | null | undefined, s: string | null | undefined): Promise<{ state: "bad" } | { state: "ask" | "done"; email: string }> {
  const email = normalizeEmail(e);
  if (!email || !s || optOutSignature(email) !== s) return { state: "bad" };
  return { state: (await isOptedOut(db, email)) ? "done" : "ask", email };
}

/** The yes from the opt-out page: only a link this server signed stops an address. */
export async function confirmOptOut(db: Db, e: string | null | undefined, s: string | null | undefined): Promise<boolean> {
  const email = normalizeEmail(e);
  if (!email || !s || optOutSignature(email) !== s) return false;
  await addOptOut(db, email);
  return true;
}
