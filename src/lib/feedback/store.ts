import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { feedback, players, type Feedback } from "@/db/schema";
import { isCoachActor } from "@/lib/domain/coaching";
import { bumpMetric } from "@/lib/domain/metrics";
import { dc } from "@/lib/discord/api";
import { sendPlainEmail } from "@/lib/outreach/desk";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";
import { baseUrl } from "@/lib/config";
import { removePushSubscription, subscriptionsFor } from "@/lib/domain/push";
import { pushEnabled, sendPush } from "@/lib/push";

/**
 * The feedback loop's memory. Intake stores a row and says thanks at once;
 * the daily session decides and, through sendFeedbackMessage, tells the
 * person what happened on the channel they used. At most three messages per
 * note, so nobody is ever pestered.
 */
export const FEEDBACK_LIMITS = { textMax: 2000, messageMax: 1500, messagesPerItem: 3, perPersonPerDay: 10 } as const;
export const FEEDBACK_STATUSES = ["new", "acknowledged", "asked", "planned", "shipped", "declined"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export type FeedbackInput = {
  source: "telegram" | "discord" | "web" | "email";
  text: string;
  locale?: string | null;
  name?: string | null;
  playerId?: string | null;
  context?: string | null;
  telegramChatId?: number | null;
  telegramUserId?: number | null;
  telegramThreadId?: number | null;
  telegramMessageId?: number | null;
  discordChannelId?: string | null;
  discordUserId?: string | null;
  discordGuildId?: string | null;
  email?: string | null;
  emailMessageId?: string | null;
};

export class FeedbackError extends Error {}

export function cleanFeedbackText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, FEEDBACK_LIMITS.textMax);
}

/** "coach" when the author runs a lessons book (or manages one); their notes are read first. */
async function authorRole(db: Db, input: FeedbackInput): Promise<"coach" | null> {
  let playerId = input.playerId ?? null;
  if (!playerId && input.telegramUserId) {
    const [p] = await db.select({ id: players.id }).from(players).where(eq(players.telegramId, input.telegramUserId)).limit(1);
    playerId = p?.id ?? null;
  }
  if (!playerId) return null;
  return (await isCoachActor(db, playerId).catch(() => false)) ? "coach" : null;
}

export async function createFeedback(db: Db, input: FeedbackInput, now = new Date()): Promise<Feedback> {
  const text = cleanFeedbackText(input.text);
  if (text.length < 3) throw new FeedbackError("too_short");
  const role = await authorRole(db, input);
  const [row] = await db
    .insert(feedback)
    .values({
      source: input.source,
      text,
      locale: input.locale === "ru" || input.locale === "es" ? input.locale : "en",
      name: input.name?.trim().slice(0, 80) || null,
      playerId: input.playerId ?? null,
      context: input.context?.slice(0, 200) ?? null,
      telegramChatId: input.telegramChatId ?? null,
      telegramUserId: input.telegramUserId ?? null,
      telegramThreadId: input.telegramThreadId ?? null,
      telegramMessageId: input.telegramMessageId ?? null,
      discordChannelId: input.discordChannelId ?? null,
      discordUserId: input.discordUserId ?? null,
      discordGuildId: input.discordGuildId ?? null,
      email: input.email?.trim().toLowerCase().slice(0, 200) || null,
      emailMessageId: input.emailMessageId ?? null,
      status: "new",
      role,
      createdAt: now,
    })
    .returning();
  await bumpMetric(db, "feedback_received").catch(() => undefined);
  return row;
}

/** How many notes this person left today (any channel key). */
export async function feedbackCountToday(db: Db, who: { telegramUserId?: number | null; discordUserId?: string | null; email?: string | null; playerId?: string | null }, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const conds = [];
  if (who.telegramUserId) conds.push(eq(feedback.telegramUserId, who.telegramUserId));
  if (who.discordUserId) conds.push(eq(feedback.discordUserId, who.discordUserId));
  if (who.email) conds.push(eq(feedback.email, who.email.toLowerCase()));
  if (who.playerId) conds.push(eq(feedback.playerId, who.playerId));
  if (conds.length === 0) return 0;
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(feedback)
    .where(and(gte(feedback.createdAt, since), conds.length === 1 ? conds[0] : sql`(${sql.join(conds, sql` or `)})`));
  return Number(n);
}

/** What this person has already been told, and how many notes they have already left. */
export type SaidBefore = { lastReply: string | null; notesBefore: number };

/**
 * The instant reply had no memory, so the same person could be sent the same sentence again and
 * again. Eriik said so on 9 September and again on 15 September, and both times the answer was
 * another line of the same shape. This is what stops that: before anything is composed, what this
 * person was last told and how many notes they have left.
 *
 * One query, bounded at twenty rows. Twenty is plenty: all that is needed is the last sentence and
 * whether this is their first note or their fifth.
 */
export async function saidBefore(db: Db, who: { telegramUserId?: number | null; discordUserId?: string | null; email?: string | null; playerId?: string | null }): Promise<SaidBefore> {
  const conds = [];
  if (who.telegramUserId) conds.push(eq(feedback.telegramUserId, who.telegramUserId));
  if (who.discordUserId) conds.push(eq(feedback.discordUserId, who.discordUserId));
  if (who.email) conds.push(eq(feedback.email, who.email.toLowerCase()));
  if (who.playerId) conds.push(eq(feedback.playerId, who.playerId));
  if (conds.length === 0) return { lastReply: null, notesBefore: 0 };
  const rows = await db
    .select({ replyText: feedback.replyText })
    .from(feedback)
    .where(conds.length === 1 ? conds[0] : sql`(${sql.join(conds, sql` or `)})`)
    .orderBy(desc(feedback.createdAt))
    .limit(20);
  return { lastReply: rows.find((r) => r.replyText)?.replyText ?? null, notesBefore: rows.length };
}

/**
 * How many player ideas are in the app, and when that number is worth showing.
 *
 * The claim "Kicksmash is built by the players on it" is worth nothing asserted and a great deal
 * proved, and the desk already holds the proof: every shipped note carries the pull request that
 * shipped it. So the screens say the number rather than the adjective.
 *
 * From three, never below. Two is a coincidence and one is an anecdote; a number that small makes
 * the claim weaker than saying nothing, and this project has a rule about counts for that reason.
 */
export const SHIPPED_FROM = 3;

export const showsShipped = (n: number): boolean => n >= SHIPPED_FROM;

/**
 * One indexed count, and only on screens that already talk to the database. The landing page makes
 * no query at all today — that is why it is fast, and why it carries the words without the number
 * (rule 12).
 */
export async function countShipped(db: Db): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(feedback).where(eq(feedback.status, "shipped"));
  return row?.n ?? 0;
}

export async function getFeedback(db: Db, id: string): Promise<Feedback | null> {
  const [row] = await db.select().from(feedback).where(eq(feedback.id, id)).limit(1);
  return row ?? null;
}

export async function listFeedback(db: Db, statuses?: string[], limit = 100): Promise<Feedback[]> {
  return db
    .select()
    .from(feedback)
    .where(statuses?.length ? inArray(feedback.status, statuses) : undefined)
    .orderBy(desc(feedback.createdAt))
    .limit(limit);
}

export async function markAcknowledged(db: Db, id: string, replyText: string, now = new Date()): Promise<void> {
  await db
    .update(feedback)
    .set({ status: "acknowledged", replyText, repliedAt: now, messagesSent: sql`${feedback.messagesSent} + 1` })
    .where(and(eq(feedback.id, id), eq(feedback.status, "new")));
}

/**
 * A note from the owner themselves, filed with nothing said back.
 *
 * Erik owns Kicksmash and plays on its courts, and on 15 September he used the feedback door twice
 * as a player. Both times the door answered him as a stranger — "Noted, Eriik. I read every note
 * myself" — and then, seconds later, the internal verdict on his own note arrived in the same chat,
 * ending "say build or skip in your Claude session". Two messages, one of them addressed to him as a
 * person who has to be reassured that somebody reads these, when the somebody is him.
 *
 * So nothing is said back. The proposal is on its way to this same chat and it is the useful one.
 * Nothing is counted as sent either, because nothing was (rule 5: the bots stay quiet).
 */
export async function markOwnNote(db: Db, id: string, now = new Date()): Promise<void> {
  await db
    .update(feedback)
    .set({ status: "acknowledged", repliedAt: now })
    .where(and(eq(feedback.id, id), eq(feedback.status, "new")));
}

/** Not feedback (an insult, a test, spam): closed at once with the one line that was sent, never on the loop's desk. */
export async function markNotFeedback(db: Db, id: string, replyText: string, now = new Date()): Promise<void> {
  await db
    .update(feedback)
    .set({ status: "declined", verdict: "not_feedback", assessment: "instant: not feedback", replyText, repliedAt: now, messagesSent: sql`${feedback.messagesSent} + 1` })
    .where(and(eq(feedback.id, id), eq(feedback.status, "new")));
}

/** The note a reply belongs to: the most recent one this person left on this channel, within two weeks. */
export async function findNoteForReply(db: Db, who: { telegramUserId?: number | null; telegramChatId?: number | null; discordUserId?: string | null; email?: string | null }, now = new Date()): Promise<Feedback | null> {
  const since = new Date(now.getTime() - 14 * 24 * 3600 * 1000);
  const conds = [];
  if (who.telegramUserId) conds.push(and(eq(feedback.telegramUserId, who.telegramUserId), ...(who.telegramChatId ? [eq(feedback.telegramChatId, who.telegramChatId)] : [])));
  if (who.discordUserId) conds.push(eq(feedback.discordUserId, who.discordUserId));
  if (who.email) conds.push(eq(feedback.email, who.email.toLowerCase()));
  if (conds.length === 0) return null;
  const [row] = await db
    .select()
    .from(feedback)
    .where(and(gte(feedback.createdAt, since), sql`${feedback.verdict} is distinct from 'not_feedback'`, conds.length === 1 ? conds[0] : sql`(${sql.join(conds, sql` or `)})`))
    .orderBy(desc(feedback.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * A reply to the thank-you joins the note it answers, dated, and puts the note back on the
 * desk: an answered question, a shipped change with a follow-up, a declined idea with a new
 * argument all get read again. The person is never asked to start over.
 */
export async function appendFeedbackReply(db: Db, id: string, replyText: string, now = new Date()): Promise<Feedback | null> {
  const clean = cleanFeedbackText(replyText);
  if (clean.length < 2) return null;
  const [row] = await db.select().from(feedback).where(eq(feedback.id, id)).limit(1);
  if (!row) return null;
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  const text = `${row.text}\n\n[reply ${stamp}] ${clean}`.slice(0, FEEDBACK_LIMITS.textMax * 3);
  const reopen = row.status === "asked" || row.status === "shipped" || row.status === "declined" || row.status === "planned";
  const [updated] = await db
    .update(feedback)
    .set({ text, ...(reopen ? { status: "acknowledged", verdict: null } : {}) })
    .where(eq(feedback.id, id))
    .returning();
  return updated ?? null;
}

export type Delivery = { status: "sent" | "failed" | "capped" | "no_channel" | "not_found"; error?: string };

/** The one way out: the person hears from us on the channel they used. */
export async function deliverToPerson(item: Feedback, text: string, fetchImpl: typeof fetch = fetch, db?: Db): Promise<Delivery> {
  const message = text.trim().slice(0, FEEDBACK_LIMITS.messageMax);
  if (!message) return { status: "failed", error: "empty" };
  if (item.messagesSent >= FEEDBACK_LIMITS.messagesPerItem) return { status: "capped" };
  if (item.source === "telegram" && item.telegramChatId && telegramEnabled()) {
    const res = await sendMessage(item.telegramChatId, esc(message), { silent: item.telegramChatId < 0, replyTo: item.telegramMessageId ?? undefined });
    if (res.ok) return { status: "sent" };
    // A group we were removed from, or a person who blocked the bot: try the private chat once.
    if (item.telegramUserId && item.telegramUserId !== item.telegramChatId) {
      const dm = await sendMessage(item.telegramUserId, esc(message));
      if (dm.ok) return { status: "sent" };
    }
    return { status: "failed", error: res.ok ? "unknown" : res.description };
  }
  if (item.source === "discord" && item.discordChannelId) {
    const res = await dc("POST", `/channels/${item.discordChannelId}/messages`, { content: item.discordUserId ? `<@${item.discordUserId}> ${message}` : message, allowed_mentions: { users: item.discordUserId ? [item.discordUserId] : [] } });
    return res.ok ? { status: "sent" } : { status: "failed", error: res.error };
  }
  if (item.email) {
    const res = await sendPlainEmail({ to: item.email, subject: item.source === "email" ? "Re: your note to Kicksmash" : "About your note to Kicksmash", text: message, inReplyTo: item.emailMessageId }, fetchImpl);
    return res.ok ? { status: "sent" } : { status: "failed", error: res.error };
  }
  if (item.telegramUserId && telegramEnabled()) {
    const res = await sendMessage(item.telegramUserId, esc(message));
    return res.ok ? { status: "sent" } : { status: "failed", error: res.description };
  }
  // A note from the in-app form carries only a player, and until now that was "no channel": Erik's
  // two notes were fixed and he never heard. The app already knows how to reach a player — the same
  // order every lesson notice takes: Telegram, then email, then this device.
  if (db && item.playerId) {
    const [p] = await db.select().from(players).where(eq(players.id, item.playerId)).limit(1);
    if (p?.telegramId && telegramEnabled()) {
      const res = await sendMessage(p.telegramId, esc(message));
      if (res.ok) return { status: "sent" };
    }
    if (p?.email) {
      const res = await sendPlainEmail({ to: p.email, subject: "About your note to Kicksmash", text: message }, fetchImpl);
      if (res.ok) return { status: "sent" };
    }
    if (p && pushEnabled()) {
      let sent = false;
      for (const sub of await subscriptionsFor(db, [p.id])) {
        const r = await sendPush(sub, { title: "Kicksmash", body: message.slice(0, 140), url: `${baseUrl()}/me` }).catch(() => "failed" as const);
        if (r === "gone") await removePushSubscription(db, sub.endpoint).catch(() => undefined);
        else if (r !== "failed") sent = true;
      }
      if (sent) return { status: "sent" };
    }
  }
  return { status: "no_channel" };
}

export type Decision = { status: Exclude<FeedbackStatus, "new" | "acknowledged">; verdict?: string | null; assessment?: string | null; message?: string | null; prUrl?: string | null; publicSummary?: string | null; publicName?: string | null };

/** Long enough for one sentence about a change, short enough that it stays one. */
export const PUBLIC_SUMMARY_MAX = 200;

/** One line of plain text, or nothing. The page shows it as written, so markup and line breaks go. */
export function cleanPublicSummary(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, PUBLIC_SUMMARY_MAX);
  return s.length >= 8 ? s : null;
}

/**
 * One first name, or nothing: the first word of a name, letters only, capitalised. "dikke henk" gives
 * "Dikke", which is why the desk can hide a test user's name with an empty string.
 */
export function cleanPublicName(raw: string | null | undefined): string | null {
  const first = (raw ?? "").replace(/<[^>]*>/g, " ").trim().split(/\s+/)[0] ?? "";
  const s = first.replace(/[^\p{L}\p{M}'’-]/gu, "").slice(0, 20);
  if (s.replace(/[^\p{L}]/gu, "").length < 2) return null;
  return s.charAt(0).toLocaleUpperCase() + s.slice(1);
}

/** The author's first name as Kicksmash shows it on a match page; never what the note itself typed. */
async function authorFirstName(db: Db, playerId: string | null): Promise<string | null> {
  if (!playerId) return null;
  const [p] = await db.select({ name: players.displayName }).from(players).where(eq(players.id, playerId)).limit(1);
  return cleanPublicName(p?.name);
}

/**
 * The line and the name /built shows, for a note already shipped, without touching its status, its
 * date or its person. A field left out stays as it is; an empty name hides the name.
 */
export async function setBuiltLine(db: Db, id: string, line: { summary?: string | null; name?: string | null }): Promise<Feedback | null> {
  const set: { publicSummary?: string | null; publicName?: string | null } = {};
  if (typeof line.summary === "string") set.publicSummary = cleanPublicSummary(line.summary);
  if (typeof line.name === "string") set.publicName = cleanPublicName(line.name);
  if (!Object.keys(set).length) return null;
  const [row] = await db
    .update(feedback)
    .set(set)
    .where(and(eq(feedback.id, id), eq(feedback.status, "shipped")))
    .returning();
  return row ?? null;
}

export type BuiltItem = { summary: string; name: string | null; shippedAt: Date };

/**
 * The public page of ideas that became the app (/built): what changed, whose idea it was, and when.
 * Only notes marked shipped with a summary somebody wrote; never the note's own words. The name is
 * the first name stored when the note shipped (the owner's decision, 23 September 2026).
 */
export async function listBuilt(db: Db, limit = 100): Promise<BuiltItem[]> {
  const rows = await db
    .select({ summary: feedback.publicSummary, name: feedback.publicName, shippedAt: feedback.shippedAt })
    .from(feedback)
    .where(and(eq(feedback.status, "shipped"), sql`${feedback.publicSummary} is not null`, sql`${feedback.shippedAt} is not null`))
    .orderBy(desc(feedback.shippedAt))
    .limit(limit);
  return rows.map((r) => ({ summary: r.summary!, name: r.name ?? null, shippedAt: r.shippedAt! }));
}

/** The daily session's verdict: recorded, and the person told, in one call. */
export async function decideFeedback(db: Db, id: string, d: Decision, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<{ item: Feedback | null; delivery: Delivery | null }> {
  const item = await getFeedback(db, id);
  if (!item) return { item: null, delivery: { status: "not_found" } };
  let delivery: Delivery | null = null;
  if (d.message && d.message.trim()) {
    delivery = await deliverToPerson(item, d.message, fetchImpl, db);
  }
  const sent = delivery?.status === "sent";
  // The name beside the line on /built: the desk's ("" hides it), else the one kept, else the author's.
  const publicName =
    d.status !== "shipped" ? item.publicName : typeof d.publicName === "string" ? cleanPublicName(d.publicName) : (item.publicName ?? (await authorFirstName(db, item.playerId)));
  const [row] = await db
    .update(feedback)
    .set({
      status: d.status,
      verdict: d.verdict?.slice(0, 20) ?? item.verdict,
      assessment: d.assessment?.slice(0, 4000) ?? item.assessment,
      prUrl: d.prUrl?.slice(0, 300) ?? item.prUrl,
      // Only a shipped note has a line on /built; a summary sent with any other verdict is not kept.
      publicSummary: d.status === "shipped" && d.publicSummary ? cleanPublicSummary(d.publicSummary) : item.publicSummary,
      publicName,
      shippedAt: d.status === "shipped" ? now : item.shippedAt,
      ...(sent ? { replyText: d.message!.trim().slice(0, FEEDBACK_LIMITS.messageMax), repliedAt: now, messagesSent: sql`${feedback.messagesSent} + 1` } : {}),
    })
    .where(eq(feedback.id, id))
    .returning();
  if (d.status === "shipped") await bumpMetric(db, "feedback_shipped").catch(() => undefined);
  return { item: row, delivery };
}

/** Sunday numbers. */
export async function feedbackWeek(db: Db, since: Date): Promise<{ received: number; shipped: number; declined: number; waiting: number }> {
  const [[r], [s], [d], [w]] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(feedback).where(gte(feedback.createdAt, since)),
    db.select({ n: sql<number>`count(*)` }).from(feedback).where(and(eq(feedback.status, "shipped"), gte(feedback.shippedAt, since))),
    // An answered question is closed as declined with the verdict `answered`: it was not an idea turned down.
    db.select({ n: sql<number>`count(*)` }).from(feedback).where(and(eq(feedback.status, "declined"), gte(feedback.repliedAt, since), sql`coalesce(${feedback.verdict}, '') not in ('not_feedback', 'answered')`)),
    db.select({ n: sql<number>`count(*)` }).from(feedback).where(inArray(feedback.status, ["new", "acknowledged", "asked", "planned"])),
  ]);
  return { received: Number(r.n), shipped: Number(s.n), declined: Number(d.n), waiting: Number(w.n) };
}
