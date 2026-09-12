import { createHash } from "node:crypto";
import { mintTicket, readTicket } from "@/lib/ticket";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { discordCards, discordChannels, players, type DiscordChannel, type Player } from "@/db/schema";
import { ApiError } from "@/lib/api/http";
import { joinAsPlayer, leaveAsPlayer, type OpContext } from "@/lib/api/operations";
import { baseUrl } from "@/lib/config";
import { composeAck } from "@/lib/feedback/ack";
import { proposeToOwner } from "@/lib/feedback/propose";
import { createFeedback, FEEDBACK_LIMITS, feedbackCountToday, markAcknowledged, markNotFeedback } from "@/lib/feedback/store";
import { feedbackStrings } from "@/lib/feedback/strings";
import { isDomainError } from "@/lib/domain/errors";
import { createPlayer } from "@/lib/domain/players";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import { isValidShareCode } from "@/lib/codes";
import { botLocale, strings, type BotLocale } from "@/lib/telegram/card";
import { EPHEMERAL, INTERACTION, RESPONSE, discordEnabled, editOriginalResponse, messageUrl, type CommandSpec, type DcInteraction, type DcUser, type InteractionResponse } from "./api";
import { postCard as postCardIn, postCardsForGroup as postCardsForGroupIn, postResult, sendReminders, syncCards } from "@/lib/channels/cards";
import { channelLocale, discordChannel, discordRoom } from "@/lib/channels/discord";
import { renderDiscordCard } from "./card";

/**
 * The Discord bot: the same quiet behaviour as the Telegram one. One card per
 * match per channel, edited in place; new messages only for the card, a
 * complete line-up, the reminder about an hour before, the result, and a
 * reply to a question someone asked. Slash commands answer ephemerally.
 */

// ---------------------------------------------------------------------------
// Channel tickets: /new hands out a create link bound to the channel, so a
// stranger cannot make the bot post into a server it was not asked from.
// ---------------------------------------------------------------------------
const ticketSecret = () => createHash("sha256").update(`discord:${process.env.DISCORD_BOT_TOKEN ?? ""}`).digest("hex");

export function channelTicket(channelId: string, now = new Date()): string {
  return mintTicket(ticketSecret(), channelId, { now });
}

/** The channel id behind a ticket issued in the last two days, or null. */
export function verifyChannelTicket(ticket: string | null | undefined, now = new Date()): string | null {
  const channelId = readTicket(ticketSecret(), ticket, { now });
  return channelId && /^\d{15,22}$/.test(channelId) ? channelId : null;
}

// ---------------------------------------------------------------------------
// People and channels
// ---------------------------------------------------------------------------
export async function findDiscordPlayer(db: Db, discordId: string): Promise<Player | null> {
  const [p] = await db.select().from(players).where(eq(players.discordId, discordId)).limit(1);
  return p ?? null;
}

const displayNameOf = (u: DcUser) => (u.global_name?.trim() || u.username).slice(0, 40);

/** The player behind a Discord account, created on first contact with their display name. */
export async function findOrCreateDiscordPlayer(db: Db, user: DcUser, locale: BotLocale = "en"): Promise<Player> {
  const existing = await findDiscordPlayer(db, user.id);
  if (existing) {
    if (user.username !== existing.discordUsername) {
      const [p] = await db.update(players).set({ discordUsername: user.username }).where(eq(players.id, existing.id)).returning();
      return p;
    }
    return existing;
  }
  const created = await createPlayer(db, { displayName: displayNameOf(user), locale });
  const [p] = await db.update(players).set({ discordId: user.id, discordUsername: user.username }).where(eq(players.id, created.id)).returning();
  return p;
}

export async function getChannel(db: Db, channelId: string): Promise<DiscordChannel | null> {
  const [c] = await db.select().from(discordChannels).where(eq(discordChannels.channelId, channelId)).limit(1);
  return c ?? null;
}

export type ChannelRef = { id: string; guildId: string; name?: string | null; guildName?: string | null };

export async function upsertChannel(db: Db, ref: ChannelRef, localeHint?: string | null): Promise<{ channel: DiscordChannel; created: boolean }> {
  const existing = await getChannel(db, ref.id);
  if (existing) {
    const name = ref.name ?? existing.name;
    const guildName = ref.guildName ?? existing.guildName;
    if (existing.name !== name || existing.guildName !== guildName || existing.leftAt) {
      const [c] = await db.update(discordChannels).set({ name, guildName, leftAt: null }).where(eq(discordChannels.channelId, ref.id)).returning();
      return { channel: c, created: false };
    }
    return { channel: existing, created: false };
  }
  const [c] = await db
    .insert(discordChannels)
    .values({ channelId: ref.id, guildId: ref.guildId, name: ref.name ?? null, guildName: ref.guildName ?? null, locale: botLocale(localeHint) })
    .onConflictDoUpdate({ target: discordChannels.channelId, set: { name: ref.name ?? null, leftAt: null } })
    .returning();
  return { channel: c, created: true };
}



// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
/** Posts the card of a match into a channel, or refreshes the one already there. The algorithm lives in src/lib/channels. */
export async function postCard(db: Db, detail: EventDetail, channel: DiscordChannel, o: { replyTo?: string | null } = {}): Promise<"posted" | "refreshed" | "failed"> {
  return postCardIn(discordChannel, db, detail, discordRoom(channel), { replyTo: o.replyTo ?? null });
}

/** A match of a group: its card goes into every channel tied to that group. */
export const postCardsForGroup = (db: Db, code: string): Promise<number> => postCardsForGroupIn(discordChannel, db, code);

/** Called after anything changed on a match: edits every card silently, notes a complete line-up once. Never throws. */
export const syncDiscord = (db: Db, code: string): Promise<number> => syncCards(discordChannel, db, code);

/** Posts the card into the channel behind a /new ticket, once the match exists. */
export async function postCardForDiscordTicket(db: Db, code: string, ticket: string | null | undefined): Promise<boolean> {
  const channelId = verifyChannelTicket(ticket);
  if (!channelId || !discordEnabled()) return false;
  const [channel, detail] = await Promise.all([getChannel(db, channelId), getEventByCode(db, code)]);
  if (!channel || channel.leftAt || !detail) return false;
  return (await postCard(db, detail, channel)) !== "failed";
}

/** About an hour before: one reminder per match into each channel that carries its card. */
export const sendDiscordReminders = (db: Db, now = new Date()): Promise<number> => sendReminders(discordChannel, db, now);

/** The first result a player records: the card, once per channel, with a line for the winners. Never throws. */
export const postDiscordResult = (db: Db, code: string): Promise<number> => postResult(discordChannel, db, code);

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------
export type Handled = { response: InteractionResponse; outcome: string; followUp?: () => Promise<void> };

const ephemeral = (content: string, components?: InteractionResponse["data"] extends infer D ? (D extends { components?: infer C } ? C : never) : never): InteractionResponse => ({ type: RESPONSE.MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...(components ? { components } : {}) } });

const CODE_RE = /(?:^|\/|\s)([A-Za-z0-9]{4})(?=$|[\s/?#])/;
const option = (i: DcInteraction, name: string) => i.data?.options?.find((o) => o.name === name)?.value;

async function handleCommand(db: Db, i: DcInteraction, user: DcUser, ctx: OpContext): Promise<Handled> {
  const name = i.data?.name ?? "";
  const base = baseUrl();
  if (!i.guild_id || !i.channel_id) return { response: ephemeral(strings(botLocale(i.locale)).notHere), outcome: "not_in_guild" };
  const { channel } = await upsertChannel(db, { id: i.channel_id, guildId: i.guild_id, name: i.channel?.name ?? null }, i.guild_locale ?? i.locale);
  const locale = channelLocale(channel);
  const s = strings(locale);
  void ctx;
  if (name === "new") {
    const params = new URLSearchParams({ dc: channelTicket(channel.channelId) });
    if (channel.venueName) params.set("venue", channel.venueName);
    const url = `${base}/?${params.toString()}`;
    return { response: ephemeral(s.newMatch, [{ type: 1, components: [{ type: 2, style: 5, label: "kicksma.sh →", url }] }]), outcome: "new" };
  }
  if (name === "match") {
    const raw = String(option(i, "code") ?? "");
    const code = raw.match(/kicksma\.sh\/([A-Za-z0-9]{4})/)?.[1] ?? raw.match(CODE_RE)?.[1] ?? raw.trim();
    const detail = code && isValidShareCode(code) ? await getEventByCode(db, code) : null;
    if (!detail) return { response: ephemeral(s.noMatch), outcome: "match_unknown" };
    const res = await postCard(db, detail, channel);
    if (res === "failed") return { response: ephemeral(s.toastError), outcome: "card_failed" };
    return { response: ephemeral(s.posted, [{ type: 1, components: [{ type: 2, style: 5, label: s.open, url: `${base}/${detail.event.code}` }] }]), outcome: "card" };
  }
  if (name === "lang") {
    const next: BotLocale = String(option(i, "language") ?? "").toLowerCase().startsWith("ru") ? "ru" : "en";
    await db.update(discordChannels).set({ locale: next }).where(eq(discordChannels.channelId, channel.channelId));
    return { response: ephemeral(strings(next).langSet), outcome: "lang" };
  }
  if (name === "feedback") {
    const text = String(option(i, "text") ?? "").trim();
    const fs = feedbackStrings(locale);
    const who = displayNameOf(user);
    if (text.length < 3) return { response: ephemeral(fs.how.replace("/feedback and the text", "/feedback text").replace("/feedback и текст", "/feedback text").replace("/feedback y el texto", "/feedback text")), outcome: "feedback_short" };
    if ((await feedbackCountToday(db, { discordUserId: user.id })) >= FEEDBACK_LIMITS.perPersonPerDay) return { response: ephemeral(fs.tooMany), outcome: "feedback_too_many" };
    const row = await createFeedback(db, { source: "discord", text, locale, name: who, context: (channel as { name?: string | null }).name ?? null, discordChannelId: channel.channelId, discordUserId: user.id, discordGuildId: channel.guildId });
    const token = i.token;
    // The reply is written for this note; that takes longer than Discord's three seconds, so defer and edit.
    return {
      response: { type: RESPONSE.DEFERRED_MESSAGE, data: { flags: EPHEMERAL } },
      outcome: `feedback:${row.id}`,
      followUp: async () => {
        const ack = await composeAck(db, { text, name: who, locale, source: "discord" });
        const res = await editOriginalResponse(token, { content: ack.reply });
        if (ack.kind === "not_feedback") await markNotFeedback(db, row.id, ack.reply);
        else if (res.ok) {
          await markAcknowledged(db, row.id, ack.reply);
          await proposeToOwner(db, row.id).catch(() => undefined);
        }
      },
    };
  }
  if (name === "ask") {
    const question = String(option(i, "question") ?? "").trim().slice(0, 1500);
    if (question.length < 8) return { response: ephemeral(s.noAnswer), outcome: "ask_short" };
    const token = i.token;
    const asked = { channelId: channel.channelId, guildId: channel.guildId, author: displayNameOf(user), text: question };
    return {
      response: { type: RESPONSE.DEFERRED_MESSAGE },
      outcome: "ask",
      followUp: async () => {
        const { answerDiscordQuestion, markDiscordReplyPosted } = await import("./listen");
        const a = await answerDiscordQuestion(db, asked);
        const res = await editOriginalResponse(token, { content: a.reply ? `**${a.author}:** ${question.slice(0, 300)}${question.length > 300 ? "…" : ""}\n\n${a.reply}` : s.noAnswer });
        if (a.reply && a.itemId && res.ok) await markDiscordReplyPosted(db, a.itemId, messageUrl(channel.guildId, channel.channelId, res.result.id));
      },
    };
  }
  return { response: ephemeral(s.discordHelp), outcome: "help" };
}

async function handleComponent(db: Db, i: DcInteraction, user: DcUser, ctx: OpContext): Promise<Handled> {
  const m = (i.data?.custom_id ?? "").match(/^([jl]):([A-Za-z0-9]{4})$/);
  const channel = i.channel_id ? await getChannel(db, i.channel_id) : null;
  const locale = channelLocale(channel, i.locale);
  const s = strings(locale);
  if (!m) return { response: { type: RESPONSE.DEFERRED_UPDATE }, outcome: "component_unknown" };
  const [, action, code] = m;
  const detail = await getEventByCode(db, code);
  if (!detail) return { response: ephemeral(s.noMatch), outcome: "component_no_match" };
  const player = await findOrCreateDiscordPlayer(db, user, botLocale(i.locale));
  let toast: string = s.toastError;
  let outcome = "error";
  try {
    if (action === "j") {
      const r = await joinAsPlayer(db, detail, player, ctx);
      outcome = r.outcome;
      toast = r.outcome === "joined" ? s.toastJoined : r.outcome === "waitlisted" ? s.toastWaitlisted : r.outcome === "already_in" ? s.toastAlready : r.outcome === "requested" ? s.toastRequested : s.toastClosed;
    } else {
      const r = await leaveAsPlayer(db, detail, player, ctx);
      outcome = r.outcome;
      toast = r.outcome === "left" ? s.toastLeft : s.toastNotIn;
    }
  } catch (e) {
    if (e instanceof ApiError && e.code === "level_required") toast = s.toastLevel;
    else if (isDomainError(e)) toast = e.code === "past" ? s.toastPast : e.code === "already_in" ? s.toastAlready : e.code === "full" || e.code === "closed" ? s.toastClosed : s.toastError;
    outcome = `error:${e instanceof ApiError ? e.code : isDomainError(e) ? e.code : "unknown"}`;
  }
  const followUp = async () => {
    await syncDiscord(db, code);
  };
  // The seat changed: the card they tapped updates in place, no extra message. Anything else gets a private note.
  if ((outcome === "joined" || outcome === "left") && i.message && channel) {
    const fresh = await getEventByCode(db, code);
    if (fresh) {
      const card = renderDiscordCard(fresh, baseUrl(), locale);
      await db.update(discordCards).set({ rendered: card.hash, updatedAt: new Date() }).where(and(eq(discordCards.channelId, channel.channelId), eq(discordCards.messageId, i.message.id)));
      return { response: { type: RESPONSE.UPDATE_MESSAGE, data: { embeds: card.embeds, components: card.components, allowed_mentions: { parse: [] } } }, outcome: `${action === "j" ? "join" : "leave"}:${outcome}`, followUp };
    }
  }
  return { response: ephemeral(toast), outcome: `${action === "j" ? "join" : "leave"}:${outcome}`, followUp };
}

/** One interaction in, the JSON to answer with and a short outcome for logs and tests. Never throws. */
export async function handleInteraction(db: Db, i: DcInteraction, ctx: OpContext): Promise<Handled> {
  try {
    if (i.type === INTERACTION.PING) return { response: { type: RESPONSE.PONG }, outcome: "pong" };
    const user = i.member?.user ?? i.user;
    if (!user || user.bot) return { response: ephemeral(strings("en").notHere), outcome: "ignored" };
    if (i.type === INTERACTION.COMMAND) return await handleCommand(db, i, user, ctx);
    if (i.type === INTERACTION.COMPONENT) return await handleComponent(db, i, user, ctx);
    return { response: ephemeral(strings(botLocale(i.locale)).discordHelp), outcome: "ignored" };
  } catch (e) {
    return { response: ephemeral(strings(botLocale(i.locale)).toastError), outcome: `error:${e instanceof Error ? e.message : String(e)}` };
  }
}

export const COMMANDS: CommandSpec[] = [
  { name: "new", description: "Create a match for this channel", description_localizations: { ru: "Создать матч для этого канала" } },
  { name: "match", description: "Post the card of a match", description_localizations: { ru: "Показать карточку матча" }, options: [{ type: 3, name: "code", description: "The 4-character code or the kicksma.sh link", required: true }] },
  { name: "ask", description: "Ask about padel formats, levels or Kicksmash", description_localizations: { ru: "Спросить о форматах, уровнях или Kicksmash" }, options: [{ type: 3, name: "question", description: "Your question", required: true }] },
  { name: "lang", description: "Bot language for this channel", description_localizations: { ru: "Язык бота в этом канале" }, options: [{ type: 3, name: "language", description: "en or ru", required: true }] },
  { name: "feedback", description: "Tell me what should change", description_localizations: { ru: "Что стоит изменить" }, options: [{ type: 3, name: "text", description: "Your words", required: true }] },
  { name: "help", description: "What I do (very little, on purpose)", description_localizations: { ru: "Что я умею (нарочно немного)" } },
];
