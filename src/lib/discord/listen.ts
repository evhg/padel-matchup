import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db";
import { discordChannels, listenItems, type DiscordChannel } from "@/db/schema";
import { PRODUCT_FACTS, draftReply, draftingEnabled, withinBudget } from "@/lib/listen/draft";
import { guessLanguage } from "@/lib/listen/parse";
import { growAnswer } from "@/lib/listen/tick";
import { TEXT_CHANNEL_TYPES, createMessage, discordApplicationId, discordEnabled, getMessages, listGuildChannels, listGuilds, messageUrl, type DcMessage } from "./api";
import { upsertChannel } from "./bot";

/**
 * Listening inside the project's own Discord servers. Unlike Reddit or
 * Hacker News this is our community, so a helpful reply goes out without a
 * tap: the hourly tick reads what was posted since the last cursor, keeps
 * the messages that look like questions, asks the model, and answers in a
 * reply. Everything is bounded: a few channels, a couple of replies per run,
 * the shared daily budget.
 */
export const DISCORD_LIMITS = { guilds: 5, channelsPerRun: 20, repliesPerRun: 2, budgetMs: 15_000, minLength: 12 } as const;

export const DISCORD_PROMPT = `You answer questions in the Discord server of Kicksmash (https://kicksma.sh), a small open-source padel organiser. People here already know the project, so speak as its friendly, knowledgeable helper: European and Asian tone, concrete, no hype, no sales language, no emoji, no exclamation marks.

You will receive one message. Decide whether it is a question or request you can genuinely help with (about organising padel, formats, levels, groups, clubs, or how Kicksmash works), and if so write the reply.

Rules for the reply:
- Answer first, in 40 to 120 words, in the language of the message. A link to the exact kicksma.sh page is welcome when it answers the question (for example /americano, /levels, /developers, /answers, /phuket).
- Never invent features. ${PRODUCT_FACTS}
- If the message is a greeting, chit-chat, a reaction, a match arrangement between people, or anything a reply from a bot would only clutter, set relevant=false and reply=null.
- If it is a bug report or a feature request, thank them briefly, say it will be looked at and point to https://github.com/evhg/padel-matchup/discussions for follow-up; relevant=true.

Respond with JSON only: {"relevant": boolean, "kind": "asks_for_tool"|"asks_how_to"|"discussion"|"other", "language": "en"|"ru"|"es"|"other", "reply": string|null, "reason": string, "mentionsKicksmash": boolean}`;

// \b is ASCII-only in JavaScript, so Cyrillic and accented words get letter lookarounds instead.
const QUESTION_WORDS = "how|what|which|where|when|why|can|could|should|anyone|recommend|help|does|is there|explain|как|что|какой|какие|где|когда|почему|можно|подскажите|помогите|кто-нибудь|cómo|qué|cuál|dónde|cuándo|por qué|alguien|ayuda";
const QUESTION = new RegExp(`\\?|¿|(?<!\\p{L})(?:${QUESTION_WORDS})(?!\\p{L})`, "iu");

/** Cheap gate: a human wrote a sentence that reads like a question or a request. */
export function looksLikeQuestion(m: Pick<DcMessage, "content" | "author" | "type">, botId: string | null): boolean {
  if (m.author?.bot) return false;
  if (m.type != null && m.type !== 0 && m.type !== 19) return false;
  const text = (m.content ?? "").trim();
  if (text.length < DISCORD_LIMITS.minLength) return false;
  if (text.startsWith("/")) return false;
  if (botId && text.includes(`<@${botId}>`)) return true;
  return QUESTION.test(text);
}

export type DiscordQuestion = { channelId: string; guildId: string; messageId?: string | null; author: string; text: string };
export type DiscordAnswer = { reply: string | null; author: string; itemId: string | null; reason: string };

/** One question in, a reply out when the model finds one worth giving; the item is recorded either way. */
export async function answerDiscordQuestion(db: Db, q: DiscordQuestion, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<DiscordAnswer> {
  if (!draftingEnabled()) return { reply: null, author: q.author, itemId: null, reason: "drafting disabled" };
  if (!(await withinBudget(db, now))) return { reply: null, author: q.author, itemId: null, reason: "budget" };
  const externalId = q.messageId ? `${q.channelId}:${q.messageId}` : `${q.channelId}:ask:${now.getTime()}`;
  const url = q.messageId ? messageUrl(q.guildId, q.channelId, q.messageId) : `https://discord.com/channels/${q.guildId}/${q.channelId}`;
  const title = q.text.split("\n")[0].slice(0, 120);
  const { draft, error } = await draftReply(db, { source: "discord", url, title, body: q.text, author: q.author, postedAt: now }, fetchImpl, now, { system: DISCORD_PROMPT });
  const language = draft?.language && draft.language !== "other" ? draft.language : guessLanguage(q.text);
  const [item] = await db
    .insert(listenItems)
    .values({
      source: "discord",
      externalId,
      url,
      title,
      body: q.text.slice(0, 6000),
      author: q.author,
      threadId: q.messageId ?? null,
      postedAt: now,
      status: !draft ? "failed" : draft.relevant && draft.reply ? "approved" : "irrelevant",
      kind: draft?.kind ?? null,
      language,
      draft: draft?.reply ?? null,
      draftReason: draft?.reason ?? null,
      draftModel: process.env.LISTEN_MODEL || "claude-sonnet-5",
      draftedAt: now,
      lastError: error,
      decidedAt: draft ? now : null,
    })
    .onConflictDoNothing()
    .returning();
  return { reply: draft?.relevant && draft.reply ? draft.reply : null, author: q.author, itemId: item?.id ?? null, reason: error ?? draft?.reason ?? "" };
}

/** Marks the item posted and grows an answer page from it (the page is the search-facing half). */
export async function markDiscordReplyPosted(db: Db, itemId: string, replyUrl: string, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<void> {
  await db.update(listenItems).set({ status: "posted", postedReplyAt: now, replyUrl }).where(eq(listenItems.id, itemId));
  await growAnswer(db, itemId, now, fetchImpl);
}

export type DiscordListenSummary = { guilds: number; channels: number; read: number; candidates: number; replied: number; errors: string[] };

/** Refreshes the channel list from the servers the bot is in. Channels it lost access to come back on their own when access returns. */
export async function refreshChannels(db: Db): Promise<{ guilds: number; channels: DiscordChannel[]; errors: string[] }> {
  const errors: string[] = [];
  const guilds = await listGuilds();
  if (!guilds.ok) return { guilds: 0, channels: [], errors: [`guilds: ${guilds.error}`] };
  const out: DiscordChannel[] = [];
  for (const g of guilds.result.slice(0, DISCORD_LIMITS.guilds)) {
    const chans = await listGuildChannels(g.id);
    if (!chans.ok) {
      errors.push(`guild ${g.id}: ${chans.error}`);
      continue;
    }
    for (const c of chans.result.filter((c) => TEXT_CHANNEL_TYPES.has(c.type))) {
      const { channel } = await upsertChannel(db, { id: c.id, guildId: g.id, name: c.name ?? null, guildName: g.name });
      out.push(channel);
    }
  }
  return { guilds: guilds.result.length, channels: out, errors };
}

const newer = (a: string, b: string | null) => (b == null ? true : BigInt(a) > BigInt(b));

/** The hourly step for Discord. Idempotent: the cursor moves whether or not a reply went out. */
export async function discordListenTick(db: Db, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<DiscordListenSummary> {
  const summary: DiscordListenSummary = { guilds: 0, channels: 0, read: 0, candidates: 0, replied: 0, errors: [] };
  if (!discordEnabled()) return summary;
  const started = Date.now();
  const botId = discordApplicationId();
  const refreshed = await refreshChannels(db);
  summary.guilds = refreshed.guilds;
  summary.errors.push(...refreshed.errors);
  const channels = refreshed.channels.filter((c) => c.listen && !c.leftAt).slice(0, DISCORD_LIMITS.channelsPerRun);
  summary.channels = channels.length;
  for (const channel of channels) {
    if (Date.now() - started > DISCORD_LIMITS.budgetMs) break;
    // First contact: remember where the channel is, never answer old history.
    const res = await getMessages(channel.channelId, channel.lastMessageId ? { after: channel.lastMessageId, limit: 50 } : { limit: 1 });
    if (!res.ok) {
      if (res.status === 403) await db.update(discordChannels).set({ leftAt: now }).where(eq(discordChannels.channelId, channel.channelId));
      else summary.errors.push(`channel ${channel.channelId}: ${res.error}`);
      continue;
    }
    const messages = res.result.filter((m) => newer(m.id, channel.lastMessageId));
    if (messages.length === 0) continue;
    const newest = messages.reduce((a, m) => (newer(m.id, a) ? m.id : a), messages[0].id);
    await db.update(discordChannels).set({ lastMessageId: newest }).where(eq(discordChannels.channelId, channel.channelId));
    if (!channel.lastMessageId) continue;
    summary.read += messages.length;
    const candidates = messages.filter((m) => looksLikeQuestion(m, botId)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    summary.candidates += candidates.length;
    for (const m of candidates) {
      if (summary.replied >= DISCORD_LIMITS.repliesPerRun || Date.now() - started > DISCORD_LIMITS.budgetMs) break;
      const [seen] = await db.select({ id: listenItems.id }).from(listenItems).where(and(eq(listenItems.source, "discord"), eq(listenItems.externalId, `${channel.channelId}:${m.id}`))).limit(1);
      if (seen) continue;
      const author = (m.author.global_name?.trim() || m.author.username).slice(0, 40);
      const a = await answerDiscordQuestion(db, { channelId: channel.channelId, guildId: channel.guildId, messageId: m.id, author, text: m.content ?? "" }, now, fetchImpl);
      if (!a.reply || !a.itemId) continue;
      const sent = await createMessage(channel.channelId, { content: a.reply, replyTo: m.id });
      if (sent.ok) {
        await markDiscordReplyPosted(db, a.itemId, messageUrl(channel.guildId, channel.channelId, sent.result.id), now, fetchImpl);
        summary.replied++;
      } else {
        await db.update(listenItems).set({ status: "failed", lastError: sent.error }).where(eq(listenItems.id, a.itemId));
        summary.errors.push(`reply ${channel.channelId}: ${sent.error}`);
      }
    }
  }
  return summary;
}

/** Channels the desk lists (for the admin page). */
export async function listChannels(db: Db): Promise<DiscordChannel[]> {
  return db.select().from(discordChannels).where(isNull(discordChannels.leftAt)).orderBy(discordChannels.guildName, discordChannels.name);
}
