import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { listenItems, type ListenItem } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";
import { draftReply, draftingEnabled, withinBudget } from "./draft";
import { guessLanguage, looksRelevant, type Candidate } from "./parse";
import { postRedditComment, redditEnabled } from "./reddit";
import { fetchAll, type FeedSpec } from "./sources";

/**
 * The listening loop, hourly:
 *   1. fetch public feeds, remember new items (7-day window)
 *   2. gate cheaply, draft with the model inside the daily budget
 *   3. ask the owner on Telegram, at most a few per day, one tap to post
 * Nothing is ever posted without that tap.
 */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const LIMITS = { draftsPerRun: 8, asksPerDay: 6 } as const;

export const ownerTelegramId = () => (process.env.TELEGRAM_OWNER_ID ? Number(process.env.TELEGRAM_OWNER_ID) : null);

export async function rememberCandidates(db: Db, items: Candidate[], now = new Date()): Promise<number> {
  const fresh = items.filter((c) => now.getTime() - c.postedAt.getTime() < WINDOW_MS);
  if (fresh.length === 0) return 0;
  const rows = await db
    .insert(listenItems)
    .values(fresh.map((c) => ({ source: c.source, externalId: c.externalId, url: c.url, title: c.title.slice(0, 300), body: c.body, author: c.author, threadId: c.threadId, postedAt: c.postedAt, status: looksRelevant(c) ? "new" : "irrelevant" })))
    .onConflictDoNothing()
    .returning({ id: listenItems.id });
  return rows.length;
}

/** Drafts for the newest gated items, inside the budget. */
export async function draftPending(db: Db, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<{ drafted: number; relevant: number; errors: number }> {
  const out = { drafted: 0, relevant: 0, errors: 0 };
  if (!draftingEnabled()) return out;
  const pending = await db.select().from(listenItems).where(eq(listenItems.status, "new")).orderBy(desc(listenItems.postedAt)).limit(LIMITS.draftsPerRun);
  for (const item of pending) {
    if (!(await withinBudget(db, now))) break;
    const { draft, error } = await draftReply(db, { source: item.source as Candidate["source"], url: item.url, title: item.title, body: item.body, author: item.author, postedAt: item.postedAt }, fetchImpl);
    if (!draft) {
      out.errors++;
      await db.update(listenItems).set({ status: "failed", lastError: error, draftedAt: now }).where(eq(listenItems.id, item.id));
      continue;
    }
    out.drafted++;
    if (draft.relevant && draft.reply) out.relevant++;
    await db
      .update(listenItems)
      .set({
        status: draft.relevant && draft.reply ? "drafted" : "irrelevant",
        kind: draft.kind,
        language: draft.language === "other" ? guessLanguage(`${item.title} ${item.body}`) : draft.language,
        draft: draft.reply,
        draftReason: draft.reason,
        draftModel: process.env.LISTEN_MODEL || "claude-sonnet-5",
        draftedAt: now,
      })
      .where(eq(listenItems.id, item.id));
  }
  return out;
}

function ownerMessage(item: ListenItem): string {
  const where = item.source === "reddit" ? "Reddit" : item.source === "hn" ? "Hacker News" : "Web";
  const manual = item.source !== "reddit" || !redditEnabled();
  return [
    `<b>${where}</b> · ${esc(item.author ?? "")}`.trim(),
    `<b>${esc(item.title)}</b>`,
    esc(item.body.slice(0, 500)) + (item.body.length > 500 ? "…" : ""),
    "",
    `<b>Draft</b> (${esc(item.language ?? "en")}${item.draft && /kicksma\.sh/i.test(item.draft) ? ", mentions kicksma.sh" : ""}):`,
    esc(item.draft ?? ""),
    "",
    manual ? "Approve = copy it yourself from the admin page (no posting API here)." : "Approve = posted as u/kicksmash right away.",
  ].join("\n");
}

/** Sends the next drafted items to the owner, a few a day, with Approve / Skip buttons. */
export async function askOwner(db: Db, now = new Date()): Promise<number> {
  const owner = ownerTelegramId();
  if (!owner || !telegramEnabled()) return 0;
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(listenItems).where(gte(listenItems.notifiedAt, since));
  let left = LIMITS.asksPerDay - Number(n);
  if (left <= 0) return 0;
  const items = await db.select().from(listenItems).where(and(eq(listenItems.status, "drafted"), isNull(listenItems.notifiedAt))).orderBy(desc(listenItems.postedAt)).limit(left);
  let sent = 0;
  for (const item of items) {
    const res = await sendMessage(owner, ownerMessage(item), {
      keyboard: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `la:${item.id}` },
            { text: "⏭ Skip", callback_data: `ls:${item.id}` },
          ],
          [
            { text: "Open thread", url: item.url },
            { text: "Edit", url: `${baseUrl()}/admin/listen?item=${item.id}` },
          ],
        ],
      },
    });
    if (res.ok) {
      await db.update(listenItems).set({ notifiedAt: now, notifyMessageId: res.result.message_id }).where(eq(listenItems.id, item.id));
      sent++;
      left--;
    }
  }
  return sent;
}

export async function getItem(db: Db, id: string): Promise<ListenItem | null> {
  const [row] = await db.select().from(listenItems).where(eq(listenItems.id, id)).limit(1);
  return row ?? null;
}

export async function saveDraft(db: Db, id: string, draft: string): Promise<ListenItem | null> {
  const [row] = await db.update(listenItems).set({ draft: draft.trim().slice(0, 1500) }).where(eq(listenItems.id, id)).returning();
  return row ?? null;
}

export async function skipItem(db: Db, id: string, now = new Date()): Promise<ListenItem | null> {
  const [row] = await db.update(listenItems).set({ status: "skipped", decidedAt: now }).where(and(eq(listenItems.id, id), inArray(listenItems.status, ["drafted", "approved", "failed"]))).returning();
  return row ?? null;
}

export type ApproveOutcome = { status: "posted"; url: string } | { status: "approved_manual" } | { status: "failed"; error: string } | { status: "not_found" } | { status: "already"; item: ListenItem };

/** Approve: post on Reddit when we can, otherwise mark approved for a manual copy. */
export async function approveItem(db: Db, id: string, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<ApproveOutcome> {
  const item = await getItem(db, id);
  if (!item || !item.draft) return { status: "not_found" };
  if (item.status === "posted") return { status: "already", item };
  if (item.source === "reddit" && item.threadId && redditEnabled()) {
    const res = await postRedditComment(item.threadId, item.draft, fetchImpl);
    if (res.ok) {
      await db.update(listenItems).set({ status: "posted", decidedAt: now, postedReplyAt: now, replyUrl: res.url, lastError: null }).where(eq(listenItems.id, id));
      return { status: "posted", url: res.url };
    }
    await db.update(listenItems).set({ status: "approved", decidedAt: now, lastError: res.error }).where(eq(listenItems.id, id));
    return { status: "failed", error: res.error };
  }
  await db.update(listenItems).set({ status: "approved", decidedAt: now }).where(eq(listenItems.id, id));
  return { status: "approved_manual" };
}

export async function markPostedManually(db: Db, id: string, replyUrl: string | null, now = new Date()): Promise<ListenItem | null> {
  const [row] = await db.update(listenItems).set({ status: "posted", postedReplyAt: now, replyUrl, decidedAt: now }).where(eq(listenItems.id, id)).returning();
  return row ?? null;
}

/** Old items fall out of the queue on their own. */
export async function expireOld(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  const rows = await db.update(listenItems).set({ status: "expired" }).where(and(inArray(listenItems.status, ["new", "drafted"]), lt(listenItems.postedAt, cutoff))).returning({ id: listenItems.id });
  return rows.length;
}

export async function listItems(db: Db, statuses: string[] = ["drafted", "approved", "posted", "failed", "skipped"], limit = 60): Promise<ListenItem[]> {
  return db.select().from(listenItems).where(inArray(listenItems.status, statuses)).orderBy(desc(listenItems.postedAt)).limit(limit);
}

/** The hourly step. Safe to run often; every part is idempotent. */
export type ListenSummary = { feeds: number; feedErrors: number; fetched: number; remembered: number; expired: number; drafted: number; relevant: number; draftErrors: number; asked: number; feedErrorDetails?: string[] };

export async function listenTick(db: Db, now = new Date(), o: { feeds?: readonly FeedSpec[]; fetchImpl?: typeof fetch } = {}): Promise<ListenSummary> {
  const fetched = await fetchAll(o.feeds, o.fetchImpl);
  const items = fetched.flatMap((f) => f.items);
  const remembered = await rememberCandidates(db, items, now);
  const expired = await expireOld(db, now);
  const drafted = await draftPending(db, now, o.fetchImpl);
  const asked = await askOwner(db, now);
  const failed = fetched.filter((f) => f.error);
  return { feeds: fetched.length, feedErrors: failed.length, fetched: items.length, remembered, expired, drafted: drafted.drafted, relevant: drafted.relevant, draftErrors: drafted.errors, asked, ...(failed.length ? { feedErrorDetails: failed.map((f) => `${f.feed.id}: ${f.error}`) } : {}) };
}
