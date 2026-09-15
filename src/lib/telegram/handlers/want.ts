import type { Db } from "@/db";
import type { TelegramChat } from "@/db/schema";
import { chatLocale } from "@/lib/channels/telegram";
import { utcToZonedParts, WEEKDAY_WORDS } from "@/lib/dates";
import { dropWant, listWants, parseWantLine, recordWant, resolvePlace, type DemandSignalView } from "@/lib/domain/demand";
import { isDomainError } from "@/lib/domain/errors";
import { answerCallbackQuery, editMessageText, esc, sendMessage, type InlineKeyboard, type TgMessage, type TgUpdate, type TgUser } from "../api";
import { strings, type BotLocale, type BotStrings } from "../card";
import { chatZone } from "../chats";
import { findOrCreateTelegramPlayer } from "../identity";

/**
 * "/want tue 14 Rawai Padel" — the one thing a player could never tell the app.
 *
 * Everything else the bot does starts from a match that exists. This starts from a person: they say
 * what they are looking for, and the next match that fits comes to them, as does the first seat that
 * opens at that hour. It is the half of "we need a fourth" the product never had.
 */

/** Sunday-first index to a name, from a week that starts on a known Sunday. */
const dayName = (d: number, locale: string) => new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + d)));

export function describeWant(w: DemandSignalView, s: BotStrings, locale: string): string {
  const day = w.onDate ?? (w.weekday === null ? s.wantAnyDay : dayName(w.weekday, locale));
  const when = w.fromTime && w.toTime ? `${w.fromTime}–${w.toTime}` : s.wantAnyTime;
  return `${day} · ${when} · ${w.venueSlug ?? w.citySlug ?? "?"}`;
}

const listKeyboard = (wants: DemandSignalView[], s: BotStrings, locale: string): InlineKeyboard => ({
  inline_keyboard: wants.slice(0, 6).map((w) => [{ text: `✕ ${describeWant(w, s, locale)}`, callback_data: `wd:${w.id}` }]),
});

export async function wantCommand(db: Db, msg: TgMessage, chat: TelegramChat, from: TgUser, args: string): Promise<string> {
  const locale: BotLocale = chatLocale(chat);
  const s = strings(locale);
  const player = await findOrCreateTelegramPlayer(db, from);
  const threadId = msg.message_thread_id ?? null;
  const say = (text: string, keyboard?: InlineKeyboard) => sendMessage(chat.chatId, esc(text), { keyboard: keyboard ?? null, replyTo: msg.message_id, threadId, silent: true });

  if (!args.trim()) {
    const mine = await listWants(db, player.id);
    if (mine.length === 0) {
      await say(`${s.wantNone}\n${s.wantHow}`);
      return "want_none";
    }
    await say(s.wantList(mine.map((w) => `· ${describeWant(w, s, locale)}`).join("\n")), listKeyboard(mine, s, locale));
    return "want_list";
  }

  const tz = (await chatZone(db, chat, args)) ?? "Asia/Bangkok";
  const line = parseWantLine(args, utcToZonedParts(new Date(), tz).date);
  const place = await resolvePlace(db, line.place, chat.venueName);
  if (!place) {
    await say(s.wantUnknownPlace);
    return "want_unknown_place";
  }
  try {
    const row = await recordWant(db, {
      playerId: player.id,
      weekday: line.weekday,
      onDate: line.onDate,
      fromTime: line.fromTime,
      toTime: line.toTime,
      venueSlug: place.venueSlug,
      citySlug: place.citySlug,
      source: "telegram",
    });
    const when = row.onDate ?? (row.weekday === null ? s.wantAnyDay : dayName(row.weekday, locale));
    const window = row.fromTime && row.toTime ? ` ${row.fromTime}–${row.toTime}` : ` ${s.wantAnyTime}`;
    await say(s.wantSaved(`${when}${window}`, row.venueSlug ?? row.citySlug ?? ""));
    return "want_saved";
  } catch (e) {
    if (!isDomainError(e)) throw e;
    await say(e.code === "too_many" ? s.wantTooMany : s.wantUnknownPlace);
    return `want_${e.code}`;
  }
}

/** The one callback this handler owns: removing a want from the list it just printed. */
export async function handleWantCallback(db: Db, cb: NonNullable<TgUpdate["callback_query"]>, id: string): Promise<string> {
  const player = await findOrCreateTelegramPlayer(db, cb.from);
  const locale: BotLocale = chatLocale(null, cb.from.language_code);
  const s = strings(locale);
  const removed = await dropWant(db, id, player.id);
  await answerCallbackQuery(cb.id, removed ? s.wantRemoved : undefined);
  if (removed && cb.message) {
    const mine = await listWants(db, player.id);
    const text = mine.length === 0 ? s.wantNone : s.wantList(mine.map((w) => `· ${describeWant(w, s, locale)}`).join("\n"));
    await editMessageText(cb.message.chat.id, cb.message.message_id, esc(text), mine.length ? listKeyboard(mine, s, locale) : null).catch(() => undefined);
  }
  return removed ? "want_removed" : "want_removed_none";
}
