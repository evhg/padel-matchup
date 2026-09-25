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
import { resultSummary } from "@/lib/channels/cards";
import { getEventPhotoMeta } from "@/lib/domain/photos";
import { cardImagePath, cardVersion } from "@/lib/resultCard";
import { deleteMessage, editMessageMedia, editMessageText, esc, miniAppUrl, sendMessage, sendPhoto, telegramEnabled, type InlineKeyboard } from "@/lib/telegram/api";
import { winStreakFor, type Streak } from "@/lib/domain/banter";
import type { Awarded } from "@/lib/domain/milestones";
import { momentLine } from "@/lib/moments";
import { strings, botLocale, type BotLocale } from "@/lib/telegram/card";
import { matchResult } from "@/lib/domain/result";
import { cardTitle } from "@/lib/telegram/card";

/**
 * After the final point. Every player, not only the organizer, hears "how did it go?" on the channel
 * they have (Telegram first, then push, then email): two hours after the start, and once more the
 * next morning if nobody has answered. In Telegram the answer is a reply with the score; the message
 * is remembered as a card so the reply finds the match.
 *
 * In Telegram the nudge is the result card itself, still waiting for its score: the two pairs, the
 * empty sets. The owner, 24 September: "when one of the players enters the result, the score nudge
 * received by all the other players changes into a result card. Changing is not an additional
 * message." Telegram swaps a photo for a photo but never text for a photo, so the nudge is a picture
 * from the start (`closeScoreNudges` does the swap). A picture Telegram cannot fetch falls back to the
 * text nudge, which is closed as text.
 */

export type NudgeSummary = { players: number; telegram: number; push: number; email: number };

/**
 * Renders the picture once before Telegram asks for it: every player's message carries the same URL,
 * so the first render fills the cache and Telegram's fetches are answered from it. Best effort.
 */
async function warm(url: string): Promise<void> {
  await fetch(url, { signal: AbortSignal.timeout(20_000) })
    .then((r) => r.arrayBuffer())
    .catch(() => undefined);
}

export async function nudgeForScore(db: Db, ev: Event, detail?: EventDetail): Promise<NudgeSummary> {
  const d = detail ?? (await getEventDetail(db, ev));
  const players = d.roster.filter((s) => isOccupied(s) && s.player).map((s) => s.player!) as Player[];
  const out: NudgeSummary = { players: players.length, telegram: 0, push: 0, email: 0 };
  const base = baseUrl();
  const subs = pushEnabled() ? await subscriptionsFor(db, players.map((p) => p.id)) : [];
  const version = telegramEnabled() && players.some((p) => p.telegramId) ? cardVersion(d, await getEventPhotoMeta(db, ev.id).catch(() => null)) : null;
  if (version) await warm(`${base}${cardImagePath(ev.code, version)}`);
  // The chat's own "who won?" pairs four players up and nothing else. Erik, 15 September, match 9wjp:
  // three were seated, so the 🏁 here could only ever answer "the result needs four players", while
  // the web took the same score from three. Any other line-up gets the score form behind the 🏁.
  const chatPairsUp = playingSeats(d).length === 4;
  for (const player of players) {
    let reached = false;
    if (telegramEnabled() && player.telegramId) {
      const locale = botLocale(player.locale);
      const s = strings(locale);
      // "add an option to tap Cancelled instead" — a match that did not happen has no score, and the
      // nudge repeats until somebody answers it. Only the organiser gets the button: cancelling is
      // theirs on every other screen, and a player who did not turn up must not close everyone's match.
      const buttons: InlineKeyboard["inline_keyboard"][number] = [chatPairsUp ? { text: s.resultBtn, callback_data: `r:${ev.code}` } : scoreFormButton(ev.code, s.resultBtn)];
      if (player.id === ev.creatorPlayerId) buttons.push({ text: s.didntPlayBtn, callback_data: `x:${ev.code}` });
      const caption = esc(s.scoreNudge(cardTitle(d, locale)));
      const keyboard = { inline_keyboard: [buttons] };
      const picture = version ? await sendPhoto(player.telegramId, `${base}${cardImagePath(ev.code, version)}`, caption, { silent: true, keyboard }).catch(() => ({ ok: false as const })) : { ok: false as const };
      const res = picture.ok ? picture : await sendMessage(player.telegramId, caption, { silent: true, keyboard }).catch(() => ({ ok: false as const }));
      if (res.ok) {
        // The reply "6-4 6-3" to this message finds the match the same way a reply to the card does.
        // One nudge per chat: the morning's replaces the evening's, so the chat never holds a stale
        // "how did it go?" with live buttons beside the one that turns into the result. `rendered` is
        // the version of the picture the message shows, and null for a text nudge.
        const [before] = await db.select({ messageId: telegramCards.messageId }).from(telegramCards).where(and(eq(telegramCards.eventId, ev.id), eq(telegramCards.chatId, player.telegramId), eq(telegramCards.kind, "nudge"))).limit(1).catch(() => []);
        const rendered = picture.ok ? version : null;
        await db
          .insert(telegramCards)
          .values({ eventId: ev.id, chatId: player.telegramId, messageId: res.result.message_id, kind: "nudge", rendered })
          .onConflictDoUpdate({ target: [telegramCards.eventId, telegramCards.chatId, telegramCards.kind], set: { messageId: res.result.message_id, rendered, updatedAt: new Date() } })
          .catch(() => undefined);
        if (before && before.messageId !== res.result.message_id) await deleteMessage(player.telegramId, before.messageId).catch(() => undefined);
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
 * The nudge, closed once somebody answers it: it becomes the result card, in place.
 *
 * "How did it go?" went to every player privately, with a 🏁 button, and then sat there live after
 * one of them entered the score on another screen. A player tapped the stale button and was told
 * "The result needs four players in the line-up" — neither true nor the point. The nudge is a card
 * like any other, so it is edited in place and its buttons go (rule 5), and what it shows is what
 * actually happened: the result card with the score, the winners, who entered it, and one button to
 * the card's page, where the court photo goes on and the picture goes to WhatsApp.
 *
 * Run again when the score is corrected or a court photo is added: the picture's version changes and
 * the card follows. An edit, never a new message — the bots stay quiet (rule 5). A nudge that already
 * shows this version is left alone; a text nudge from before the picture is closed as text.
 *
 * Best effort per message: a chat that blocked the bot, or a message too old to edit, must not stop
 * the rest. Returns how many were edited.
 */
export async function closeScoreNudges(db: Db, code: string): Promise<number> {
  if (!telegramEnabled()) return 0;
  const detail = await getEventByCode(db, code);
  if (!detail || detail.scores.length === 0) return 0;
  const rows = await db
    .select({ id: telegramCards.id, chatId: telegramCards.chatId, messageId: telegramCards.messageId, rendered: telegramCards.rendered, locale: telegramChats.locale })
    .from(telegramCards)
    .innerJoin(telegramChats, eq(telegramChats.chatId, telegramCards.chatId))
    .where(and(eq(telegramCards.eventId, detail.event.id), eq(telegramCards.kind, "nudge")));
  if (rows.length === 0) return 0;
  const line = scoreLine(detail);
  if (!line) return 0;
  const base = baseUrl();
  const version = cardVersion(detail, await getEventPhotoMeta(db, detail.event.id).catch(() => null));
  const picture = `${base}${cardImagePath(code, version)}`;
  if (rows.some((r) => r.rendered !== null && r.rendered !== version)) await warm(picture);
  // The winners' streak, as the group's result post tells it: read once, and only for a picture that changes.
  let streak: Streak | null | undefined;
  let closed = 0;
  for (const row of rows) {
    const locale: BotLocale = botLocale(row.locale);
    const s = strings(locale);
    if (row.rendered === null) {
      const res = await editMessageText(row.chatId, row.messageId, esc(`${cardTitle(detail, locale)} — ${s.scoreAlready(line.who, line.score)}`), null).catch(() => ({ ok: false as const }));
      if (res.ok) closed++;
      continue;
    }
    if (row.rendered === version) continue;
    if (streak === undefined) streak = await winStreakFor(db, detail).catch(() => null);
    const summary = resultSummary(detail, locale, base, streak);
    const caption = [summary?.title ?? cardTitle(detail, locale), line.score, summary?.winners, summary?.winners ? summary.praise : null, summary?.banter, line.who ? s.scoreBy(line.who) : null].filter(Boolean).map((x) => esc(String(x))).join("\n");
    const res = await editMessageMedia(row.chatId, row.messageId, picture, caption, { inline_keyboard: [[{ text: s.cardBtn, url: `${base}/${code}/card` }]] }).catch(() => ({ ok: false as const }));
    if (res.ok) {
      await db.update(telegramCards).set({ rendered: version, updatedAt: new Date() }).where(eq(telegramCards.id, row.id)).catch(() => undefined);
      closed++;
    }
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

type Seat = EventDetail["roster"][number];
/** Who played: the seats inside the capacity with a player in them, in seat order. The chat's "who won?" takes exactly four. */
export const playingSeats = (detail: EventDetail): Seat[] => detail.roster.filter((x) => x.position <= detail.event.capacity && isOccupied(x) && x.playerId).sort((a, b) => a.position - b.position);

/**
 * The one way on when the chat cannot finish the result itself: fewer than four players seated, or
 * pairs nobody has set. Every such door used to end in a sentence ("the result needs four players",
 * "tap 🏁 on the card first") while the match page took the same score. This button opens that page's
 * score form with the player already signed in.
 *
 * It never carries a secret. A message keeps its buttons when it is forwarded, and the nudge is a
 * picture of the result card that a player may well forward to the crew's group; a personal link in
 * it would sign the next reader in as this player (`docs/DECIDING.md` rule 7). So the button is the
 * Mini App, which signs in whoever opens it from Telegram's own initData: the direct link when the
 * owner has created the app in BotFather, else a web_app button on the `/tg` shell, which needs no
 * BotFather step (the menu button in `/api/telegram/setup` opens the same page). Telegram passes no
 * start parameter to a web_app button, so the shell's URL carries it (`miniAppStart`), and `r_`
 * lands on `#score` (`miniAppNext`). A web_app button works only in a private chat, which is the
 * only place this one goes.
 */
export function scoreFormButton(code: string, label: string): InlineKeyboard["inline_keyboard"][number][number] {
  const start = `r_${code}`;
  const app = miniAppUrl(start);
  return app ? { text: label, url: app } : { text: label, web_app: { url: `${baseUrl()}/tg?startapp=${encodeURIComponent(start)}` } };
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
