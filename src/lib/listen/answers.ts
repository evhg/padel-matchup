import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { activity, answers, clubs, discordChannels, events, listenItems, players, telegramChats, type Answer, type ListenItem } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { bumpMetric, dayKey } from "@/lib/domain/metrics";
import { metricsDaily } from "@/db/schema";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";
import { draftingEnabled, withinBudget } from "./draft";
import { ownerTelegramId } from "./tick";

/**
 * Answers: once the owner approved a reply, the same question becomes an
 * evergreen page at /answers/{slug}, rewritten generically (no names, no
 * thread specifics), published at once, and offered for one-tap unpublish in
 * the weekly digest. This is the search-facing half of the listening desk.
 */
const ANSWER_PROMPT = `You turn one approved community reply into a short evergreen help page for kicksma.sh, an open padel organiser.

Rules:
- Rewrite the question generically: no names, no venue names, no dates, no quotes from the original poster. It must read like a question many people ask.
- Keep the answer factual and complete in 120 to 220 words, same language as the reply. Keep any mention of kicksma.sh exactly as neutral as the reply had it, never more. Never invent features.
- Title: a plain question of at most 70 characters. Slug: lowercase ASCII words joined by hyphens, at most 60 characters, language-neutral English words even for Russian or Spanish pages (e.g. "mexicano-8-players-2-courts-ru").
- If the reply is too situational to generalise, return {"skip": true}.

Respond with JSON only: {"skip": false, "title": string, "slug": string, "question": string, "answer": string, "language": "en"|"ru"|"es"}`;

type Generated = { skip: boolean; title?: string; slug?: string; question?: string; answer?: string; language?: string };

const cleanSlug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export function parseGenerated(text: string): Generated | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Generated;
    if (j.skip) return { skip: true };
    if (!j.title || !j.slug || !j.question || !j.answer) return null;
    const slug = cleanSlug(j.slug);
    if (!slug) return null;
    return { skip: false, title: j.title.trim().slice(0, 90), slug, question: j.question.trim().slice(0, 600), answer: j.answer.trim().slice(0, 2500), language: j.language === "ru" || j.language === "es" ? j.language : "en" };
  } catch {
    return null;
  }
}

async function uniqueSlug(db: Db, base: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base.slice(0, 55)}-${i + 1}`;
    const [hit] = await db.select({ id: answers.id }).from(answers).where(eq(answers.slug, slug)).limit(1);
    if (!hit) return slug;
  }
  return `${base.slice(0, 48)}-${Date.now().toString(36)}`;
}

/** Grows an answer page from an approved item. One model call, budgeted; failures are silent (the reply itself is what mattered). */
export async function generateAnswer(db: Db, item: ListenItem, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<Answer | null> {
  if (!draftingEnabled() || !item.draft) return null;
  const [existing] = await db.select().from(answers).where(eq(answers.sourceItemId, item.id)).limit(1);
  if (existing) return existing;
  if (!(await withinBudget(db, now))) return null;
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.LISTEN_MODEL || "claude-sonnet-5", max_tokens: 900, system: ANSWER_PROMPT, messages: [{ role: "user", content: `Original question (${item.language ?? "en"}):\n${item.title}\n${item.body.slice(0, 1500)}\n\nApproved reply:\n${item.draft}` }] }),
      signal: AbortSignal.timeout(45_000),
    });
    const json = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number } } | null;
    const usage = { input: json?.usage?.input_tokens ?? 0, output: json?.usage?.output_tokens ?? 0 };
    const day = dayKey(now);
    await Promise.all([bumpMetric(db, "listen_drafts", 1, day), usage.input ? bumpMetric(db, "anthropic_in", usage.input, day) : null, usage.output ? bumpMetric(db, "anthropic_out", usage.output, day) : null]);
    if (!res.ok || !json) return null;
    const gen = parseGenerated((json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(""));
    if (!gen || gen.skip) return null;
    const slug = await uniqueSlug(db, gen.slug!);
    const [row] = await db
      .insert(answers)
      .values({ slug, language: gen.language!, title: gen.title!, question: gen.question!, answer: gen.answer!, sourceItemId: item.id, publishedAt: now })
      .returning();
    return row;
  } catch {
    return null;
  }
}

export async function listPublishedAnswers(db: Db, limit = 100): Promise<Answer[]> {
  return db.select().from(answers).where(and(isNotNull(answers.publishedAt), isNull(answers.unpublishedAt))).orderBy(desc(answers.publishedAt)).limit(limit);
}

export async function listAllAnswers(db: Db, limit = 100): Promise<Answer[]> {
  return db.select().from(answers).orderBy(desc(answers.createdAt)).limit(limit);
}

export async function getPublishedAnswer(db: Db, slug: string): Promise<Answer | null> {
  const [row] = await db.select().from(answers).where(and(eq(answers.slug, slug), isNotNull(answers.publishedAt), isNull(answers.unpublishedAt))).limit(1);
  return row ?? null;
}

export async function setAnswerPublished(db: Db, id: string, on: boolean, now = new Date()): Promise<Answer | null> {
  const [row] = await db.update(answers).set(on ? { publishedAt: now, unpublishedAt: null } : { unpublishedAt: now }).where(eq(answers.id, id)).returning();
  return row ?? null;
}

/**
 * Sunday morning, once: what the system did this week and the new answer
 * pages, each with an Unpublish button. Quiet the other six days.
 */
export async function sendWeeklyDigest(db: Db, now = new Date()): Promise<boolean> {
  const owner = ownerTelegramId();
  if (!owner || !telegramEnabled()) return false;
  if (now.getUTCDay() !== 0 || now.getUTCHours() < 7) return false;
  const day = dayKey(now);
  const [sent] = await db.select({ value: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.day, day), eq(metricsDaily.key, "listen_digest"))).limit(1);
  if (sent && Number(sent.value) > 0) return false;
  const since = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const [[posted], [approvedManual], [matches], [chats], newAnswers, spend] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(listenItems).where(and(eq(listenItems.status, "posted"), gte(listenItems.postedReplyAt, since))),
    db.select({ n: sql<number>`count(*)` }).from(listenItems).where(and(eq(listenItems.status, "approved"), gte(listenItems.decidedAt, since))),
    db.select({ n: sql<number>`count(*)` }).from(events).where(gte(events.createdAt, since)),
    db.select({ n: sql<number>`count(*)` }).from(telegramChats).where(and(isNull(telegramChats.leftAt), sql`${telegramChats.type} <> 'private'`)),
    db.select().from(answers).where(and(isNotNull(answers.publishedAt), isNull(answers.unpublishedAt), isNull(answers.digestedAt))).orderBy(desc(answers.publishedAt)).limit(10),
    db.select({ key: metricsDaily.key, total: sql<number>`sum(${metricsDaily.value})` }).from(metricsDaily).where(and(gte(metricsDaily.day, dayKey(since)), sql`${metricsDaily.key} in ('anthropic_in','anthropic_out','listen_drafts')`)).groupBy(metricsDaily.key),
  ]);
  const spent = Object.fromEntries(spend.map((r) => [r.key, Number(r.total)]));
  // The numbers that say whether the product works: new people, people joining, matches that ended in a result, clubs.
  const [[newPlayers], [joins], [results], [newClubs], [channels]] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(players).where(gte(players.createdAt, since)),
    db.select({ n: sql<number>`count(*)` }).from(activity).where(and(eq(activity.verb, "joined"), gte(activity.createdAt, since))),
    db.select({ n: sql<number>`count(distinct ${activity.eventId})` }).from(activity).where(and(eq(activity.verb, "score_entered"), gte(activity.createdAt, since))),
    db.select({ n: sql<number>`count(*)` }).from(clubs).where(gte(clubs.createdAt, since)),
    db.select({ n: sql<number>`count(*)` }).from(discordChannels).where(isNull(discordChannels.leftAt)),
  ]);
  const lines = [
    "<b>Kicksmash, this week</b>",
    `New players: ${Number(newPlayers.n)} · joins: ${Number(joins.n)} · matches with a result: ${Number(results.n)}`,
    `Matches created: ${Number(matches.n)} · Telegram chats with the bot: ${Number(chats.n)} · Discord channels: ${Number(channels.n)} · clubs claimed: ${Number(newClubs.n)}`,
    `Replies posted: ${Number(posted.n)} · approved for manual posting: ${Number(approvedManual.n)}`,
    `Drafts: ${spent.listen_drafts ?? 0} · tokens in ${Math.round((spent.anthropic_in ?? 0) / 1000)}k, out ${Math.round((spent.anthropic_out ?? 0) / 1000)}k`,
    newAnswers.length ? `\nNew answer pages (${newAnswers.length}), each with an Unpublish button below:` : "\nNo new answer pages this week.",
  ];
  const head = await sendMessage(owner, lines.join("\n"), { keyboard: { inline_keyboard: [[{ text: "Listening desk", url: `${baseUrl()}/admin/listen` }]] } });
  if (!head.ok) return false;
  await bumpMetric(db, "listen_digest", 1, day);
  for (const a of newAnswers) {
    const res = await sendMessage(owner, `<b>${esc(a.title)}</b>\n${esc(a.answer.slice(0, 300))}${a.answer.length > 300 ? "…" : ""}`, {
      keyboard: {
        inline_keyboard: [
          [
            { text: "Open", url: `${baseUrl()}/answers/${a.slug}` },
            { text: "🗑 Unpublish", callback_data: `lu:${a.id}` },
          ],
        ],
      },
      silent: true,
    });
    if (res.ok) await db.update(answers).set({ digestedAt: now }).where(eq(answers.id, a.id));
  }
  return true;
}
