import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { discordCards, discordChannels, events, players, type DiscordChannel, type Player } from "@/db/schema";
import { ApiError } from "@/lib/api/http";
import { joinAsPlayer, leaveAsPlayer, type OpContext } from "@/lib/api/operations";
import { baseUrl } from "@/lib/config";
import { formatEventTime } from "@/lib/dates";
import { isDomainError } from "@/lib/domain/errors";
import { isOccupied } from "@/lib/domain/events";
import { createPlayer } from "@/lib/domain/players";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import { matchResult } from "@/lib/domain/result";
import { isValidShareCode } from "@/lib/codes";
import { botLocale, cardTitle, strings, whereLine, type BotLocale } from "@/lib/telegram/card";
import { EPHEMERAL, INTERACTION, RESPONSE, createMessage, discordEnabled, editMessage, editOriginalResponse, messageUrl, type CommandSpec, type DcInteraction, type DcUser, type InteractionResponse } from "./api";
import { renderDiscordCard } from "./card";

/**
 * The Discord bot: the same quiet behaviour as the Telegram one. One card per
 * match per channel, edited in place; new messages only for the card, a
 * complete line-up, the reminder about an hour before, the result, and a
 * reply to a question someone asked. Slash commands answer ephemerally.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Channel tickets: /new hands out a create link bound to the channel, so a
// stranger cannot make the bot post into a server it was not asked from.
// ---------------------------------------------------------------------------
const ticketSecret = () => createHash("sha256").update(`discord:${process.env.DISCORD_BOT_TOKEN ?? ""}`).digest("hex");
const ticketSig = (channelId: string, bucket: number) => createHmac("sha256", ticketSecret()).update(`${channelId}.${bucket}`).digest("hex").slice(0, 20);

export function channelTicket(channelId: string, now = new Date()): string {
  const bucket = Math.floor(now.getTime() / DAY_MS);
  return `${channelId}.${bucket}.${ticketSig(channelId, bucket)}`;
}

/** The channel id behind a ticket issued in the last two days, or null. */
export function verifyChannelTicket(ticket: string | null | undefined, now = new Date()): string | null {
  if (!ticket) return null;
  const [channelId, b, sig] = ticket.split(".");
  const bucket = Number(b);
  if (!/^\d{15,22}$/.test(channelId ?? "") || !Number.isInteger(bucket) || !sig) return null;
  const current = Math.floor(now.getTime() / DAY_MS);
  if (bucket !== current && bucket !== current - 1) return null;
  const want = ticketSig(channelId, bucket);
  if (want.length !== sig.length) return null;
  return timingSafeEqual(Buffer.from(want), Buffer.from(sig)) ? channelId : null;
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

const channelLocale = (c: DiscordChannel | null, fallback?: string | null): BotLocale => (c ? (c.locale === "ru" ? "ru" : "en") : botLocale(fallback));

/** A 403 / missing access means the bot cannot see the channel any more; a 404 message means the card was deleted. */
async function noteFailure(db: Db, channel: DiscordChannel, cardId: string | null, res: { ok: false; status: number; error: string }): Promise<void> {
  if (res.status === 403 || /Missing Access|Missing Permissions/i.test(res.error)) await db.update(discordChannels).set({ leftAt: new Date() }).where(eq(discordChannels.channelId, channel.channelId));
  else if (res.status === 404 && cardId) await db.delete(discordCards).where(eq(discordCards.id, cardId));
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
/** Posts the card of a match into a channel, or refreshes the one already there. */
export async function postCard(db: Db, detail: EventDetail, channel: DiscordChannel, o: { replyTo?: string | null } = {}): Promise<"posted" | "refreshed" | "failed"> {
  const ev = detail.event;
  const [existing] = await db.select().from(discordCards).where(and(eq(discordCards.eventId, ev.id), eq(discordCards.channelId, channel.channelId), eq(discordCards.kind, "card"))).limit(1);
  if (existing) {
    await syncDiscord(db, ev.code);
    return "refreshed";
  }
  const card = renderDiscordCard(detail, baseUrl(), channelLocale(channel));
  const sent = await createMessage(channel.channelId, { embeds: card.embeds, components: card.components, replyTo: o.replyTo ?? null });
  if (!sent.ok) {
    await noteFailure(db, channel, null, sent);
    return "failed";
  }
  await db.insert(discordCards).values({ eventId: ev.id, channelId: channel.channelId, messageId: sent.result.id, kind: "card", rendered: card.hash }).onConflictDoNothing();
  return "posted";
}

/** Called after anything changed on a match: edits every card silently, notes a complete line-up once. Never throws. */
export async function syncDiscord(db: Db, code: string): Promise<number> {
  if (!discordEnabled()) return 0;
  try {
    const detail = await getEventByCode(db, code);
    if (!detail) return 0;
    const cards = await db
      .select({ card: discordCards, channel: discordChannels })
      .from(discordCards)
      .innerJoin(discordChannels, eq(discordChannels.channelId, discordCards.channelId))
      .where(and(eq(discordCards.eventId, detail.event.id), eq(discordCards.kind, "card"), isNull(discordChannels.leftAt)));
    let edits = 0;
    for (const { card, channel } of cards) {
      const locale = channelLocale(channel);
      const rendered = renderDiscordCard(detail, baseUrl(), locale);
      if (rendered.hash !== card.rendered) {
        const res = await editMessage(channel.channelId, card.messageId, { embeds: rendered.embeds, components: rendered.components });
        if (res.ok) {
          await db.update(discordCards).set({ rendered: rendered.hash, updatedAt: new Date() }).where(eq(discordCards.id, card.id));
          edits++;
        } else {
          await noteFailure(db, channel, card.id, res);
          continue;
        }
      }
      if (rendered.complete && !card.completeNotedAt && detail.event.status !== "cancelled") {
        const s = strings(locale);
        const occupied = detail.roster.filter((x) => x.position <= detail.event.capacity && isOccupied(x)).length;
        const note = await createMessage(channel.channelId, { content: s.completeNote(occupied, formatEventTime(detail.event.startsAt, detail.event.tz, locale)), replyTo: card.messageId, suppressNotifications: true });
        if (note.ok) await db.update(discordCards).set({ completeNotedAt: new Date() }).where(eq(discordCards.id, card.id));
      }
    }
    return edits;
  } catch {
    return 0;
  }
}

/** Posts the card into the channel behind a /new ticket, once the match exists. */
export async function postCardForDiscordTicket(db: Db, code: string, ticket: string | null | undefined): Promise<boolean> {
  const channelId = verifyChannelTicket(ticket);
  if (!channelId || !discordEnabled()) return false;
  const [channel, detail] = await Promise.all([getChannel(db, channelId), getEventByCode(db, code)]);
  if (!channel || channel.leftAt || !detail) return false;
  return (await postCard(db, detail, channel)) !== "failed";
}

/** About an hour before: one reminder per match into each channel that carries its card. */
export async function sendDiscordReminders(db: Db, now = new Date()): Promise<number> {
  if (!discordEnabled()) return 0;
  const soon = new Date(now.getTime() + 90 * 60 * 1000);
  const due = await db
    .select({ id: events.id, code: events.code })
    .from(events)
    .where(and(gt(events.startsAt, now), lte(events.startsAt, soon), isNull(events.discordReminderSentAt), inArray(events.status, ["open", "full"]), sql`exists (select 1 from ${discordCards} c where c.event_id = ${events.id} and c.kind = 'card')`))
    .limit(50);
  let sent = 0;
  for (const row of due) {
    await db.update(events).set({ discordReminderSentAt: now }).where(eq(events.id, row.id));
    const detail = await getEventByCode(db, row.code);
    if (!detail) continue;
    const cards = await db
      .select({ card: discordCards, channel: discordChannels })
      .from(discordCards)
      .innerJoin(discordChannels, eq(discordChannels.channelId, discordCards.channelId))
      .where(and(eq(discordCards.eventId, row.id), eq(discordCards.kind, "card"), isNull(discordChannels.leftAt)));
    for (const { card, channel } of cards) {
      const locale = channelLocale(channel);
      const s = strings(locale);
      const occupied = detail.roster.filter((x) => x.position <= detail.event.capacity && isOccupied(x)).length;
      const res = await createMessage(channel.channelId, { content: s.reminder(cardTitle(detail, locale), whereLine(detail, locale), occupied, detail.event.capacity), replyTo: card.messageId });
      if (res.ok) sent++;
    }
  }
  return sent;
}

/** Once the organizer finalizes: the result, once per channel. Never throws. */
export async function postDiscordResult(db: Db, code: string): Promise<number> {
  if (!discordEnabled()) return 0;
  try {
    const detail = await getEventByCode(db, code);
    if (!detail || !detail.event.scoreLockedByCreator) return 0;
    const ev = detail.event;
    const cards = await db
      .select({ card: discordCards, channel: discordChannels })
      .from(discordCards)
      .innerJoin(discordChannels, eq(discordChannels.channelId, discordCards.channelId))
      .where(and(eq(discordCards.eventId, ev.id), isNull(discordChannels.leftAt)));
    const done = new Set(cards.filter((c) => c.card.kind === "result").map((c) => c.channel.channelId));
    let posted = 0;
    for (const { card, channel } of cards.filter((c) => c.card.kind === "card" && !done.has(c.channel.channelId))) {
      const locale = channelLocale(channel);
      const s = strings(locale);
      const lines: string[] = [];
      if (ev.type === "match") {
        const r = matchResult(
          detail.scores,
          detail.roster.map((x) => ({ team: x.team, status: x.status, name: x.player?.displayName ?? x.invitedName ?? "?" })),
        );
        if (r) {
          lines.push(`**${r.score}**`);
          if (r.hasTeams && r.winner !== "draw") lines.push(s.winner((r.winner === "a" ? r.a : r.b).join(" & ")));
        }
      } else if (ev.standings?.length) {
        const names = new Map(detail.roster.filter((x) => x.playerId).map((x) => [x.playerId!, x.player?.displayName ?? "?"]));
        lines.push(s.winner(ev.standings.slice(0, 3).map((id, i) => `${i + 1}. ${names.get(id) ?? "?"}`).join("  ")));
      }
      const url = `${baseUrl()}/${ev.code}/card`;
      const res = await createMessage(channel.channelId, {
        embeds: [{ title: `${s.result} · ${cardTitle(detail, locale)}`, url, description: lines.join("\n") || undefined, image: { url: `${baseUrl()}/${ev.code}/card/opengraph-image` }, color: 0x0ea5e9 }],
        components: [{ type: 1, components: [{ type: 2, style: 5, label: s.open, url }] }],
        replyTo: card.messageId,
      });
      if (res.ok) {
        await db.insert(discordCards).values({ eventId: ev.id, channelId: channel.channelId, messageId: res.result.id, kind: "result" }).onConflictDoNothing();
        posted++;
      }
    }
    return posted;
  } catch {
    return 0;
  }
}

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
  { name: "help", description: "What I do (very little, on purpose)", description_localizations: { ru: "Что я умею (нарочно немного)" } },
];
