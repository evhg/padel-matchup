import { and, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { emailMarks } from "@/db/schema";

/**
 * Bounces and complaints: when an address stops working, the app stops writing to it and says so.
 *
 * Until 23 September 2026 Kicksmash handled neither. A dead address kept counting as reachable, so
 * "everybody was told" was false for its owner, and Resend's own suppression list quietly refused
 * each new attempt (nine for one address in six days). The rules:
 *
 *   - A hard bounce (the address does not exist) marks it at once.
 *   - A complaint (somebody pressed "spam") marks it at once, and is the strongest signal there is.
 *   - A soft bounce (a full mailbox, a server down) marks it only after three, because a full
 *     mailbox empties.
 *   - A marked address is not written to (`sendEmail`), does not count as reachable (a match tells
 *     its player on Telegram or by push instead), the player sees it on their own page and the
 *     organiser sees it beside the name.
 *   - A six-digit code that arrives at the address proves it works, and clears the mark.
 */
export type MarkKind = "hard" | "soft" | "complaint";
export const SOFT_BOUNCES_TO_MARK = 3;
const STRENGTH: Record<MarkKind, number> = { soft: 0, hard: 1, complaint: 2 };

export const normalAddress = (s: string | null | undefined): string => {
  const raw = (s ?? "").trim();
  // "Name <a@b.c>" as Resend may write it.
  const inBrackets = raw.match(/<([^>]+)>/)?.[1];
  return (inBrackets ?? raw).trim().toLowerCase();
};

type ResendEvent = { type?: string; data?: { to?: string[] | string; bounce?: { type?: string; subType?: string; message?: string } } };

/** What a Resend webhook event says about which addresses, or nothing when it says nothing about one. */
export function markFromEvent(event: ResendEvent): { addresses: string[]; kind: MarkKind; reason: string } | null {
  const to = event.data?.to;
  const addresses = (Array.isArray(to) ? to : to ? [to] : []).map(normalAddress).filter((a) => a.includes("@"));
  if (!addresses.length) return null;
  const b = event.data?.bounce;
  switch (event.type) {
    case "email.complained":
      return { addresses, kind: "complaint", reason: "marked as spam" };
    case "email.bounced": {
      // Resend passes the mail system's verdict on: Permanent is an address that is not there.
      const hard = (b?.type ?? "").toLowerCase() === "permanent";
      return { addresses, kind: hard ? "hard" : "soft", reason: [b?.type, b?.subType, b?.message].filter(Boolean).join(": ").slice(0, 300) || "bounced" };
    }
    case "email.suppressed":
      return { addresses, kind: "hard", reason: "on Resend's suppression list" };
    default:
      return null;
  }
}

/**
 * Resend's test addresses (bounced@, complained@, delivered@resend.dev) bounce or complain on purpose.
 * A mark for one says nothing about a person, and one test turned the board's bounce row yellow.
 */
const TEST_DOMAINS = ["resend.dev"];
const isTestAddress = (address: string) => TEST_DOMAINS.includes(address.split("@")[1] ?? "");

/** Records one event for one address and says whether the address is now marked. */
export async function recordMark(db: Db, rawAddress: string, kind: MarkKind, reason: string, now = new Date()): Promise<boolean> {
  const address = normalAddress(rawAddress);
  if (!address.includes("@") || isTestAddress(address)) return false;
  const soft = kind === "soft" ? 1 : 0;
  const [row] = await db
    .insert(emailMarks)
    .values({ address, kind, softCount: soft, reason, markedAt: kind === "soft" ? null : now, firstAt: now, lastAt: now })
    .onConflictDoUpdate({
      target: emailMarks.address,
      set: {
        // The strongest verdict stays: a soft bounce after a complaint is still a complaint.
        kind: sql`case when ${STRENGTH[kind]} > (case ${emailMarks.kind} when 'complaint' then 2 when 'hard' then 1 else 0 end) then ${kind} else ${emailMarks.kind} end`,
        softCount: sql`${emailMarks.softCount} + ${soft}`,
        reason,
        lastAt: now,
        markedAt: sql`coalesce(${emailMarks.markedAt}, case when ${kind} <> 'soft' or ${emailMarks.softCount} + ${soft} >= ${SOFT_BOUNCES_TO_MARK} then ${now.toISOString()}::timestamptz end)`,
      },
    })
    .returning({ markedAt: emailMarks.markedAt });
  return Boolean(row?.markedAt);
}

/** Of these addresses, the ones marked: one indexed read for a whole roster. */
export async function markedAmong(db: Db, addresses: readonly (string | null | undefined)[]): Promise<Set<string>> {
  const wanted = [...new Set(addresses.map(normalAddress).filter((a) => a.includes("@")))];
  if (!wanted.length) return new Set();
  const rows = await db
    .select({ address: emailMarks.address })
    .from(emailMarks)
    .where(and(inArray(emailMarks.address, wanted), isNotNull(emailMarks.markedAt)));
  return new Set(rows.map((r) => r.address));
}

export async function markOf(db: Db, address: string | null | undefined): Promise<{ kind: MarkKind; markedAt: Date } | null> {
  const a = normalAddress(address);
  if (!a.includes("@")) return null;
  const [row] = await db.select().from(emailMarks).where(and(sql`${emailMarks.address} = ${a}`, isNotNull(emailMarks.markedAt))).limit(1);
  return row?.markedAt ? { kind: row.kind as MarkKind, markedAt: row.markedAt } : null;
}

/** A code arrived at this address, so it works: whatever marked it is over. */
export async function clearMark(db: Db, address: string | null | undefined): Promise<void> {
  const a = normalAddress(address);
  if (a.includes("@")) await db.delete(emailMarks).where(sql`${emailMarks.address} = ${a}`);
}

/**
 * The person typed this address in again, which is asking for mail again: a complaint or a run of soft
 * bounces is lifted, the way an opt-out is. A hard bounce is not: the address did not exist, and only
 * a code arriving at it says otherwise.
 */
export async function liftOnConsent(db: Db, address: string | null | undefined): Promise<void> {
  const a = normalAddress(address);
  if (a.includes("@")) await db.delete(emailMarks).where(and(sql`${emailMarks.address} = ${a}`, sql`${emailMarks.kind} <> 'hard'`));
}

/** For the service board: addresses that bounced or complained since a day, by kind. */
export async function marksSince(db: Db, since: Date): Promise<{ bounced: number; complained: number }> {
  const rows = await db
    .select({ kind: emailMarks.kind, n: sql<number>`count(*)::int` })
    .from(emailMarks)
    .where(gte(emailMarks.lastAt, since))
    .groupBy(emailMarks.kind);
  const n = (k: string) => Number(rows.find((r) => r.kind === k)?.n ?? 0);
  return { bounced: n("hard") + n("soft"), complained: n("complaint") };
}
