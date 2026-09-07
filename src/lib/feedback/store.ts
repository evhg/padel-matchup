import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { feedback, type Feedback } from "@/db/schema";
import { bumpMetric } from "@/lib/domain/metrics";
import { dc } from "@/lib/discord/api";
import { sendPlainEmail } from "@/lib/outreach/desk";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";

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

export async function createFeedback(db: Db, input: FeedbackInput, now = new Date()): Promise<Feedback> {
  const text = cleanFeedbackText(input.text);
  if (text.length < 3) throw new FeedbackError("too_short");
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

export type Delivery = { status: "sent" | "failed" | "capped" | "no_channel" | "not_found"; error?: string };

/** The one way out: the person hears from us on the channel they used. */
export async function deliverToPerson(item: Feedback, text: string, fetchImpl: typeof fetch = fetch): Promise<Delivery> {
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
  return { status: "no_channel" };
}

export type Decision = { status: Exclude<FeedbackStatus, "new" | "acknowledged">; verdict?: string | null; assessment?: string | null; message?: string | null; prUrl?: string | null };

/** The daily session's verdict: recorded, and the person told, in one call. */
export async function decideFeedback(db: Db, id: string, d: Decision, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<{ item: Feedback | null; delivery: Delivery | null }> {
  const item = await getFeedback(db, id);
  if (!item) return { item: null, delivery: { status: "not_found" } };
  let delivery: Delivery | null = null;
  if (d.message && d.message.trim()) {
    delivery = await deliverToPerson(item, d.message, fetchImpl);
  }
  const sent = delivery?.status === "sent";
  const [row] = await db
    .update(feedback)
    .set({
      status: d.status,
      verdict: d.verdict?.slice(0, 20) ?? item.verdict,
      assessment: d.assessment?.slice(0, 4000) ?? item.assessment,
      prUrl: d.prUrl?.slice(0, 300) ?? item.prUrl,
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
    db.select({ n: sql<number>`count(*)` }).from(feedback).where(and(eq(feedback.status, "declined"), gte(feedback.repliedAt, since))),
    db.select({ n: sql<number>`count(*)` }).from(feedback).where(inArray(feedback.status, ["new", "acknowledged", "asked", "planned"])),
  ]);
  return { received: Number(r.n), shipped: Number(s.n), declined: Number(d.n), waiting: Number(w.n) };
}
