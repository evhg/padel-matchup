import type { Db } from "@/db";
import { and, eq } from "drizzle-orm";
import { telegramCards, telegramChats, type Event, type Player } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { isOccupied } from "@/lib/domain/events";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { subscriptionsFor, removePushSubscription } from "@/lib/domain/push";
import { getEventByCode, getEventDetail, type EventDetail } from "@/lib/domain/queries";
import { emailEnabled } from "@/lib/config";
import { sendEmail } from "@/lib/email/send";
import { layout, translatorFor } from "@/lib/email/templates";
import { venueWithCourt } from "@/lib/labels";
import { personalEventUrl } from "@/lib/personal";
import { pushEnabled, sendPush } from "@/lib/push";
import { editMessageText, esc, sendMessage, sendPhoto, telegramEnabled } from "@/lib/telegram/api";
import type { Awarded } from "@/lib/domain/milestones";
import { momentLine } from "@/lib/moments";
import { strings, botLocale, type BotLocale } from "@/lib/telegram/card";
import { matchResult } from "@/lib/domain/result";
import { cardTitle } from "@/lib/telegram/card";

/**
 * After the final point. Every player, not only the organizer, hears once: "how did it go?"
 * on the channel they have (Telegram first, then push, then email). In Telegram the answer
 * is a reply with the score; the message is remembered as a card so the reply finds the match.
 */

export type NudgeSummary = { players: number; telegram: number; push: number; email: number };

export async function nudgeForScore(db: Db, ev: Event, detail?: EventDetail): Promise<NudgeSummary> {
  const d = detail ?? (await getEventDetail(db, ev));
  const players = d.roster.filter((s) => isOccupied(s) && s.player).map((s) => s.player!) as Player[];
  const out: NudgeSummary = { players: players.length, telegram: 0, push: 0, email: 0 };
  const base = baseUrl();
  const subs = pushEnabled() ? await subscriptionsFor(db, players.map((p) => p.id)) : [];
  for (const player of players) {
    let reached = false;
    if (telegramEnabled() && player.telegramId) {
      const locale = botLocale(player.locale);
      const s = strings(locale);
      // "add an option to tap Cancelled instead" — a match that did not happen has no score, and the
      // nudge repeats until somebody answers it. Only the organiser gets the button: cancelling is
      // theirs on every other screen, and a player who did not turn up must not close everyone's match.
      const buttons: { text: string; callback_data: string }[] = [{ text: s.resultBtn, callback_data: `r:${ev.code}` }];
      if (player.id === ev.creatorPlayerId) buttons.push({ text: s.didntPlayBtn, callback_data: `x:${ev.code}` });
      const res = await sendMessage(player.telegramId, esc(s.scoreNudge(cardTitle(d, locale))), { silent: true, keyboard: { inline_keyboard: [buttons] } }).catch(() => ({ ok: false as const }));
      if (res.ok) {
        // The reply "6-4 6-3" to this message finds the match the same way a reply to the card does.
        await db.insert(telegramCards).values({ eventId: ev.id, chatId: player.telegramId, messageId: res.result.message_id, kind: "nudge" }).onConflictDoNothing().catch(() => undefined);
        out.telegram++;
        reached = true;
      }
    }
    const mine = subs.filter((x) => x.playerId === player.id);
    if (mine.length) {
      const { t, locale } = await translatorFor(player.locale);
      const venue = venueWithCourt(ev, { venueTbd: t("event.venueTbd"), courtNumber: (n) => t("event.courtNumber", { n }) });
      const payload = { title: t("push.scoreTitle"), body: t("push.scoreBody", { venue }), url: `${personalEventUrl(base, await getOrCreatePersonalToken(db, player.id), ev.code)}#score`, tag: `score-${ev.code}` };
      void locale;
      for (const sub of mine) {
        const r = await sendPush(sub, payload);
        if (r === "sent") {
          out.push++;
          reached = true;
        }
        if (r === "gone") await removePushSubscription(db, sub.endpoint);
      }
    }
    if (!reached && emailEnabled() && player.email && player.emailNotifications) {
      const { t, locale } = await translatorFor(player.locale);
      const venue = venueWithCourt(ev, { venueTbd: t("event.venueTbd"), courtNumber: (n) => t("event.courtNumber", { n }) });
      const vars = { day: formatEventDay(ev.startsAt, ev.tz, locale), time: formatEventTime(ev.startsAt, ev.tz, locale), venue };
      const url = `${personalEventUrl(base, await getOrCreatePersonalToken(db, player.id), ev.code)}#score`;
      const { html, text } = layout({ heading: t("email.scoreNudge.heading"), body: t("email.scoreNudge.body", vars), cta: { label: t("email.scoreNudge.cta"), url }, footer: t("email.footer", { app: "Kicksmash" }), eventUrl: url, openLabel: t("email.scoreNudge.cta") });
      if (await sendEmail({ to: player.email, subject: t("email.scoreNudge.subject"), html, text })) out.email++;
    }
  }
  return out;
}

/**
 * The nudge, closed once somebody answers it.
 *
 * "How did it go?" went to every player privately, with a 🏁 button, and then sat there live after
 * one of them entered the score on another screen. A player tapped the stale button and was told
 * "The result needs four players in the line-up" — neither true nor the point. The nudge is a card
 * like any other, so it is edited in place and its button goes (rule 5), and what it says is what
 * actually happened: who answered, and with what.
 *
 * Best effort per message: a chat that blocked the bot, or a message too old to edit, must not stop
 * the rest. Returns how many were closed.
 */
export async function closeScoreNudges(db: Db, code: string): Promise<number> {
  if (!telegramEnabled()) return 0;
  const detail = await getEventByCode(db, code);
  if (!detail || detail.scores.length === 0) return 0;
  const rows = await db
    .select({ chatId: telegramCards.chatId, messageId: telegramCards.messageId, locale: telegramChats.locale })
    .from(telegramCards)
    .innerJoin(telegramChats, eq(telegramChats.chatId, telegramCards.chatId))
    .where(and(eq(telegramCards.eventId, detail.event.id), eq(telegramCards.kind, "nudge")));
  if (rows.length === 0) return 0;
  const line = scoreLine(detail);
  if (!line) return 0;
  let closed = 0;
  for (const row of rows) {
    const locale: BotLocale = botLocale(row.locale);
    const s = strings(locale);
    const res = await editMessageText(row.chatId, row.messageId, esc(`${cardTitle(detail, locale)} — ${s.scoreAlready(line.who, line.score)}`), null).catch(() => ({ ok: false as const }));
    if (res.ok) closed++;
  }
  // The rows stay: a reply to this message still finds the match, which is how a correction arrives.
  return closed;
}

/** The score as a person would say it, and who put it there — from rows the caller already has. */
export function scoreLine(detail: EventDetail): { who: string | null; score: string } | null {
  if (detail.scores.length === 0) return null;
  const r = matchResult(
    detail.scores,
    detail.roster.map((x) => ({ team: x.team, status: x.status, name: x.player?.displayName ?? x.invitedName ?? "?" })),
  );
  const score = r?.score?.trim();
  if (!score) return null;
  const by = detail.scores.find((x) => x.enteredByPlayerId)?.enteredByPlayerId ?? null;
  const who = by ? (detail.roster.find((x) => x.playerId === by)?.player?.displayName ?? null) : null;
  return { who, score };
}

/** A moment, once, to the player who earned it: the picture and one button, silent. Web and email players find it on My matches. */
export async function notifyMilestones(awarded: Awarded[]): Promise<number> {
  if (!telegramEnabled()) return 0;
  const base = baseUrl();
  let sent = 0;
  for (const { milestone, player } of awarded) {
    if (!player.telegramId) continue;
    const line = await momentLine(milestone, player.locale);
    const url = `${base}/m/${milestone.id}`;
    const keyboard = { inline_keyboard: [[{ text: player.locale === "ru" ? "Открыть" : player.locale === "es" ? "Abrir" : "Open", url }]] };
    const photo = await sendPhoto(player.telegramId, `${url}/opengraph-image`, esc(line), { keyboard, silent: true }).catch(() => ({ ok: false as const }));
    const res = photo.ok ? photo : await sendMessage(player.telegramId, `${esc(line)}\n${url}`, { keyboard, silent: true }).catch(() => ({ ok: false as const }));
    if (res.ok) sent++;
  }
  return sent;
}
