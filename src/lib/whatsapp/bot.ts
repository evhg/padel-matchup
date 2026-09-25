import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { formatEventDateTime } from "@/lib/dates";
import { isClaimable } from "@/lib/domain/events";
import { isDomainError } from "@/lib/domain/errors";
import { getEventByCode } from "@/lib/domain/queries";
import { leaveEvent } from "@/lib/domain/slots";
import { joinWithPolicy, wasComplete } from "@/lib/domain/joining";
import { afterJoin, afterLeave } from "@/lib/aftermath";
import { isValidShareCode } from "@/lib/codes";
import { feedCalendar, feedKeyFor, feedLinks } from "@/lib/calendarFeed";
import { bumpMetric } from "@/lib/domain/metrics";
import { getPlayer } from "@/lib/domain/players";
import type { EventDetail } from "@/lib/domain/queries";
import { subjectUuid } from "@/lib/ticket";
import { readInbound, sendButtons, sendText, type WaContact, type WaInboundMessage } from "./api";
import { bindInText, codeInJoinText, verifyBindTicket } from "./link";
import { findOrCreateWhatsappPlayer, linkWhatsapp, sameNumber } from "./identity";

/**
 * The conversation. One person, one thread, and the whole of a player's loop inside it: see the
 * match, take a spot, give it up, ask who else is in.
 *
 * What is deliberately absent is the shared card. Nobody here learns the roster filled by scrolling
 * past; they learn it by asking. That is the real cost of this channel and it belongs in the code
 * rather than only in a document — see the note at the top of `api.ts` for why no amount of tier or
 * paperwork changes it.
 */

type Locale = "en" | "ru" | "es";
const localeOf = (p: Player): Locale => (p.locale?.startsWith("ru") ? "ru" : p.locale?.startsWith("es") ? "es" : "en");

const S = {
  en: {
    help: "Send me a match link from your group chat and I will put you in it. You can also send a four-letter match code.",
    gone: "I cannot find that match. It may have been cancelled.",
    joined: (when: string, left: number) => `You are in. ${when}.${left > 0 ? ` ${left} still to find.` : " That is four — the match is on."}`,
    waitlisted: (when: string) => `The match is full, so you are on the waitlist. ${when}. I will tell you if a spot opens.`,
    already: "You are already in this one.",
    left: "You are out. I have told the organiser.",
    notIn: "You are not in this match.",
    full: "It filled up while you were tapping. You are on the waitlist.",
    past: "That match has already been played.",
    lineup: (names: string, left: number) => (names ? `In so far: ${names}.${left > 0 ? ` ${left} to find.` : ""}` : "Nobody has taken a spot yet."),
    join: "I'm in",
    leave: "Can't make it",
    who: "Who else is in?",
    requested: "This match has a level range, so the organiser decides. I have asked them and will tell you either way.",
    levelNeeded: (url: string) => `This match is for a level range and I do not know yours. Set it here first, then tap again: ${url}`,
    linked: (match: string | null, calendar: string | null) => `Linked: this number is yours on Kicksmash now. Send a match link here any time to join or to see who is in.${match ? `\n\n${match}` : ""}${calendar ? `\n\n📅 Your matches in your calendar, updating themselves: ${calendar}` : ""}`,
    linkBad: "This link is too old. Open the match page and tap WhatsApp again.",
  },
  ru: {
    help: "Пришлите ссылку на матч из вашего чата, и я запишу вас. Можно прислать и код матча из четырёх символов.",
    gone: "Не нахожу такой матч. Возможно, его отменили.",
    joined: (when: string, left: number) => `Вы в игре. ${when}.${left > 0 ? ` Ещё ${left} не хватает.` : " Это четверо — матч состоится."}`,
    waitlisted: (when: string) => `Мест нет, вы в листе ожидания. ${when}. Сообщу, если место освободится.`,
    already: "Вы уже записаны сюда.",
    left: "Вы вышли. Организатору сообщил.",
    notIn: "Вас нет в этом матче.",
    full: "Место заняли, пока вы нажимали. Вы в листе ожидания.",
    past: "Этот матч уже сыгран.",
    lineup: (names: string, left: number) => (names ? `Сейчас в составе: ${names}.${left > 0 ? ` Не хватает ${left}.` : ""}` : "Пока никто не записался."),
    join: "Я играю",
    leave: "Не смогу",
    who: "Кто уже в составе?",
    requested: "У матча есть диапазон уровня, решает организатор. Я спросил и сообщу вам ответ.",
    levelNeeded: (url: string) => `У матча есть диапазон уровня, а ваш мне неизвестен. Укажите его здесь и нажмите снова: ${url}`,
    linked: (match: string | null, calendar: string | null) => `Готово: этот номер теперь ваш в Kicksmash. Присылайте сюда ссылку на матч, чтобы записаться или узнать, кто играет.${match ? `\n\n${match}` : ""}${calendar ? `\n\n📅 Ваши матчи в календаре, обновляются сами: ${calendar}` : ""}`,
    linkBad: "Эта ссылка устарела. Откройте страницу матча и снова нажмите WhatsApp.",
  },
  es: {
    help: "Mándame un enlace de partido de tu chat y te apunto. También vale un código de cuatro letras.",
    gone: "No encuentro ese partido. Puede que lo cancelaran.",
    joined: (when: string, left: number) => `Estás dentro. ${when}.${left > 0 ? ` Faltan ${left}.` : " Ya sois cuatro — el partido va."}`,
    waitlisted: (when: string) => `Está completo, así que estás en la lista de espera. ${when}. Te aviso si se libera una plaza.`,
    already: "Ya estás en este.",
    left: "Estás fuera. Se lo he dicho al organizador.",
    notIn: "No estás en este partido.",
    full: "Se llenó mientras tocabas. Estás en la lista de espera.",
    past: "Ese partido ya se jugó.",
    lineup: (names: string, left: number) => (names ? `Hasta ahora: ${names}.${left > 0 ? ` Faltan ${left}.` : ""}` : "Todavía no se ha apuntado nadie."),
    join: "Voy",
    leave: "No puedo",
    who: "¿Quién más va?",
    requested: "Este partido tiene un rango de nivel, así que decide el organizador. Se lo he preguntado y te diré la respuesta.",
    levelNeeded: (url: string) => `Este partido tiene un rango de nivel y no sé el tuyo. Ponlo aquí y vuelve a tocar: ${url}`,
    linked: (match: string | null, calendar: string | null) => `Listo: este número ya es tuyo en Kicksmash. Mándame aquí un enlace de partido cuando quieras para apuntarte o ver quién va.${match ? `\n\n${match}` : ""}${calendar ? `\n\n📅 Tus partidos en tu calendario, se actualizan solos: ${calendar}` : ""}`,
    linkBad: "Este enlace es demasiado antiguo. Abre la página del partido y toca WhatsApp otra vez.",
  },
} as const;

const spotsLeft = (detail: EventDetail) => detail.roster.filter(isClaimable).length;
const namesIn = (detail: EventDetail) => detail.roster.filter((s) => s.player).map((s) => s.player!.displayName);
const whenOf = (detail: EventDetail, locale: string) => formatEventDateTime(detail.event.startsAt, detail.event.tz, locale);

/** The match, then the three things a player can do about it. */
async function showMatch(to: string, detail: EventDetail, locale: Locale): Promise<void> {
  const s = S[locale];
  const left = spotsLeft(detail);
  const where = detail.event.venueName ? ` · ${detail.event.venueName}` : "";
  const head = `${whenOf(detail, locale)}${where}\n${s.lineup(namesIn(detail).join(", "), left)}\n${baseUrl()}/${detail.event.code}`;
  await sendButtons(to, head, [
    { id: `wj:${detail.event.code}`, title: s.join },
    { id: `wl:${detail.event.code}`, title: s.leave },
    { id: `ww:${detail.event.code}`, title: s.who },
  ]);
}

/**
 * A `LINK-` code from the match page's "stay updated" card: this number becomes the web player's, and
 * the answer is their match and their calendar. It is a reply to the message the player just sent,
 * so it is free and inside the 24-hour window, like every other answer here. It runs before the
 * number is looked up, because looking it up creates a player for a new number, and a linked number
 * must not leave a second one behind.
 */
async function bindFromPage(db: Db, from: string, bind: { ticket: string; code: string | null }): Promise<string> {
  const id = subjectUuid(bind.ticket);
  const target = id ? await getPlayer(db, id) : null;
  const locale = target ? localeOf(target) : "en";
  const s = S[locale];
  // Sent twice: the number is theirs already, so the answer is the one they had the first time.
  const already = Boolean(target && sameNumber(target.phone, from));
  if (!target || (!already && !verifyBindTicket(bind.ticket, target))) {
    await sendText(from, s.linkBad);
    return "wa:link_bad";
  }
  const linked = already ? target : await linkWhatsapp(db, target.id, from);
  if (!already) await bumpMetric(db, "stay_linked_whatsapp").catch(() => undefined);
  const detail = bind.code ? await getEventByCode(db, bind.code) : null;
  const match = detail ? `${whenOf(detail, locale)}${detail.event.venueName ? ` · ${detail.event.venueName}` : ""}\n${baseUrl()}/${detail.event.code}` : null;
  // The calendar page, never the personal link: a message can be forwarded, and the page signs nobody in.
  // An address on file already brings an invitation per match; the feed as well would show each one twice.
  const calendar = feedCalendar(linked) ? feedLinks(baseUrl(), await feedKeyFor(db, linked), locale).page : null;
  await sendText(from, s.linked(match, calendar));
  return "wa:linked";
}

/**
 * One inbound message, answered. Returns a short outcome string, as every other channel's handler
 * does, so the webhook's response says what happened and the browser suite can assert on it.
 */
export async function handleWhatsappMessage(db: Db, msg: WaInboundMessage, contact?: WaContact): Promise<string> {
  const bind = msg.type === "text" ? bindInText(readInbound(msg).text) : null;
  if (bind) return bindFromPage(db, msg.from, bind);
  const player = await findOrCreateWhatsappPlayer(db, msg.from, contact?.profile?.name);
  const locale = localeOf(player);
  const s = S[locale];
  const { text, tappedId } = readInbound(msg);

  const tap = tappedId ? /^(wj|wl|ww):([A-Za-z0-9]{4})$/.exec(tappedId) : null;
  // Never re-cased: the code alphabet is mixed case, so changing it finds a different match or none.
  const code = tap ? tap[2] : (codeInJoinText(text) ?? (isValidShareCode(text.trim()) ? text.trim() : null));
  if (!code) {
    await sendText(msg.from, s.help);
    return "wa:help";
  }

  const detail = await getEventByCode(db, code);
  if (!detail || detail.event.status === "cancelled") {
    await sendText(msg.from, s.gone);
    return "wa:gone";
  }

  if (!tap || tap[1] === "ww") {
    // A bare code, a pasted link, or "who else is in?" all answer the same way: the match as it stands.
    await showMatch(msg.from, detail, locale);
    return tap ? "wa:lineup" : "wa:match";
  }

  const before = wasComplete(detail);

  if (tap[1] === "wl") {
    const out = await leaveEvent(db, { eventId: detail.event.id, playerId: player.id }).catch(() => null);
    if (!out?.left) {
      await sendText(msg.from, s.notIn);
      return "wa:not_in";
    }
    await sendText(msg.from, s.left);
    // The same six things the web form does, from the one list both call (see lib/aftermath.ts).
    await afterLeave(db, out, player, { wasComplete: before, code }).catch(() => undefined);
    return "wa:left";
  }

  try {
    const decision = await joinWithPolicy(db, detail, player, player.level);
    if (decision.kind === "level_required") {
      await sendText(msg.from, s.levelNeeded(`${baseUrl()}/${code}`));
      return "wa:level_required";
    }
    if (decision.kind === "requested") {
      await sendText(msg.from, s.requested);
      return "wa:requested";
    }
    const out = decision.result;
    const now = (await getEventByCode(db, code)) ?? detail;
    if (out.outcome === "already_in") await sendText(msg.from, s.already);
    else if (out.outcome === "full") await sendText(msg.from, s.full);
    else if (out.outcome === "waitlisted") await sendText(msg.from, s.waitlisted(whenOf(now, locale)));
    else await sendText(msg.from, s.joined(whenOf(now, locale), spotsLeft(now)));
    if (out.outcome === "joined" || out.outcome === "waitlisted") {
      await afterJoin(db, out, player, { wasComplete: before, code, level: player.level }).catch(() => undefined);
    }
    return `wa:${out.outcome}`;
  } catch (e) {
    if (!isDomainError(e)) throw e;
    await sendText(msg.from, e.code === "past" ? s.past : e.code === "full" ? s.full : s.gone);
    return `wa:${e.code}`;
  }
}
