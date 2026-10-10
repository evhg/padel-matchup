import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { formatEventDateTime } from "@/lib/dates";
import { isClaimable } from "@/lib/domain/events";
import { isDomainError } from "@/lib/domain/errors";
import { getEventByCode } from "@/lib/domain/queries";
import { confirmInvite, leaveEvent } from "@/lib/domain/slots";
import { joinWithPolicy, wasComplete } from "@/lib/domain/joining";
import { afterJoin, afterLeave } from "@/lib/aftermath";
import { isValidShareCode } from "@/lib/codes";
import { feedCalendar, feedKeyFor, feedLinks } from "@/lib/calendarFeed";
import { rangeChoices } from "@/lib/domain/levelAsk";
import { formatLevel, normalizeLevel } from "@/lib/domain/levels";
import { isOver } from "@/lib/domain/matchLength";
import { nameIsHere } from "@/lib/domain/dupes";
import { joinGroup } from "@/lib/domain/groups";
import { bumpMetric } from "@/lib/domain/metrics";
import { setPlayerLevel } from "@/lib/domain/rating";
import { takeRate } from "@/lib/domain/ratelimit";
import { notifyCreator, notifyLineupChange, sendCalendarInvite } from "@/lib/notify";
import { getPlayer } from "@/lib/domain/players";
import type { EventDetail } from "@/lib/domain/queries";
import { subjectUuid } from "@/lib/ticket";
import { readInbound, sendButtons, sendText, type WaContact, type WaInboundMessage } from "./api";
import { bindInText, codeInJoinText, codeInMatchUrl, verifyBindTicket } from "./link";
import { findOrCreateWhatsappPlayer, findWhatsappPlayer, linkWhatsapp, sameNumber } from "./identity";

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
    help: "Send JOIN and the match code (JOIN 7KQ2) and I put you in at once, then tell you who else is in. Send a match link to see the match first. Once you are in, you can say you can't make it, ask who is in, or add the match to your calendar.",
    gone: "I cannot find that match. It may have been cancelled.",
    joined: (when: string, left: number) => `You are in. ${when}.${left > 0 ? "" : " That is everyone — the match is on."}`,
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
    calendar: "Add to calendar",
    calendarFeed: (url: string) => `📅 Your matches in your calendar, updating themselves: ${url}`,
    calendarOne: (url: string) => `📅 This match for your calendar: ${url}`,
    requested: "This match has a level range, so the organiser decides. I have asked them and will tell you either way.",
    levelAsk: (range: string) => `This match is for levels ${range}. Which is yours? I save it and put you in.`,
    linked: (match: string | null, calendar: string | null) => `Linked: this number is yours on Kicksmash now. Send a match link here any time to join or to see who is in.${match ? `\n\n${match}` : ""}${calendar ? `\n\n📅 Your matches in your calendar, updating themselves: ${calendar}` : ""}`,
    linkBad: "This link is too old. Open the match page and tap WhatsApp again.",
  },
  ru: {
    help: "Пришлите JOIN и код матча (JOIN 7KQ2), и я сразу запишу вас и скажу, кто ещё играет. Пришлите ссылку на матч, чтобы сначала посмотреть его. Когда вы записаны, можно отказаться, узнать, кто играет, или добавить матч в календарь.",
    gone: "Не нахожу такой матч. Возможно, его отменили.",
    joined: (when: string, left: number) => `Вы в игре. ${when}.${left > 0 ? "" : " Все в сборе — матч состоится."}`,
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
    calendar: "В календарь",
    calendarFeed: (url: string) => `📅 Ваши матчи в календаре, обновляются сами: ${url}`,
    calendarOne: (url: string) => `📅 Этот матч для вашего календаря: ${url}`,
    requested: "У матча есть диапазон уровня, решает организатор. Я спросил и сообщу вам ответ.",
    levelAsk: (range: string) => `Матч для уровня ${range}. Какой у вас? Я сохраню его и запишу вас.`,
    linked: (match: string | null, calendar: string | null) => `Готово: этот номер теперь ваш в Kicksmash. Присылайте сюда ссылку на матч, чтобы записаться или узнать, кто играет.${match ? `\n\n${match}` : ""}${calendar ? `\n\n📅 Ваши матчи в календаре, обновляются сами: ${calendar}` : ""}`,
    linkBad: "Эта ссылка устарела. Откройте страницу матча и снова нажмите WhatsApp.",
  },
  es: {
    help: "Mándame JOIN y el código del partido (JOIN 7KQ2) y te apunto al momento, y te digo quién más va. Mándame el enlace de un partido para verlo antes. Cuando ya estás dentro, puedes decir que no puedes, ver quién va o añadir el partido a tu calendario.",
    gone: "No encuentro ese partido. Puede que lo cancelaran.",
    joined: (when: string, left: number) => `Estás dentro. ${when}.${left > 0 ? "" : " Ya estáis todos — el partido va."}`,
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
    calendar: "Al calendario",
    calendarFeed: (url: string) => `📅 Tus partidos en tu calendario, se actualizan solos: ${url}`,
    calendarOne: (url: string) => `📅 Este partido para tu calendario: ${url}`,
    requested: "Este partido tiene un rango de nivel, así que decide el organizador. Se lo he preguntado y te diré la respuesta.",
    levelAsk: (range: string) => `Este partido es para nivel ${range}. ¿Cuál es el tuyo? Lo guardo y te apunto.`,
    linked: (match: string | null, calendar: string | null) => `Listo: este número ya es tuyo en Kicksmash. Mándame aquí un enlace de partido cuando quieras para apuntarte o ver quién va.${match ? `\n\n${match}` : ""}${calendar ? `\n\n📅 Tus partidos en tu calendario, se actualizan solos: ${calendar}` : ""}`,
    linkBad: "Este enlace es demasiado antiguo. Abre la página del partido y toca WhatsApp otra vez.",
  },
} as const;

const spotsLeft = (detail: EventDetail) => detail.roster.filter(isClaimable).length;
const namesIn = (detail: EventDetail) => detail.roster.filter((s) => s.player).map((s) => s.player!.displayName);
const whenOf = (detail: EventDetail, locale: string) => formatEventDateTime(detail.event.startsAt, detail.event.tz, locale);
const whereOf = (detail: EventDetail) => (detail.event.venueName ? ` · ${detail.event.venueName}` : "");

/** The match, then the three things a player can do about it. */
async function showMatch(to: string, detail: EventDetail, locale: Locale): Promise<void> {
  const s = S[locale];
  const left = spotsLeft(detail);
  const head = `${whenOf(detail, locale)}${whereOf(detail)}\n${s.lineup(namesIn(detail).join(", "), left)}\n${baseUrl()}/${detail.event.code}`;
  await sendButtons(to, head, [
    { id: `wj:${detail.event.code}`, title: s.join },
    { id: `wl:${detail.event.code}`, title: s.leave },
    { id: `ww:${detail.event.code}`, title: s.who },
  ]);
}

/**
 * The answer to a seat taken (or already held): one line that says so, the line-up as it now stands,
 * the match link, and what a player in a match may want next. "I'm in" is not among the buttons,
 * because they are.
 */
async function showSeat(to: string, detail: EventDetail, locale: Locale, headline: string): Promise<void> {
  const s = S[locale];
  const code = detail.event.code;
  await sendButtons(to, `${headline}\n${s.lineup(namesIn(detail).join(", "), spotsLeft(detail))}\n${baseUrl()}/${code}`, [
    { id: `wl:${code}`, title: s.leave },
    { id: `ww:${code}`, title: s.who },
    { id: `wc:${code}`, title: s.calendar },
  ]);
}

/** "3.0–4.5", "3.0+", "up to 4.5": the match's range in the plainest words a button's question can carry. */
function rangeWords(min: number | null, max: number | null): string {
  if (min != null && max != null) return `${formatLevel(min)}–${formatLevel(max)}`;
  if (min != null) return `${formatLevel(min)}+`;
  return `≤ ${formatLevel(max ?? 0)}`;
}

/**
 * A ranged match and no level on file: up to three buttons with levels drawn from the match's own range
 * (`rangeChoices`: its bottom, middle and top), instead of a link out of the chat. The tap saves the
 * number tapped as the player's own declaration, and only when they have none (`setPlayerLevel`), then
 * joins through the same rules as every other door: a match that takes confirmed levels only still
 * makes it a request to the organiser.
 */
async function askLevel(to: string, detail: EventDetail, locale: Locale): Promise<void> {
  const s = S[locale];
  const code = detail.event.code;
  await sendButtons(
    to,
    s.levelAsk(rangeWords(detail.event.levelMin, detail.event.levelMax)),
    rangeChoices(detail.event.levelMin, detail.event.levelMax).map((level) => ({ id: `wv:${code}:${Math.round(level * 100)}`, title: formatLevel(level) })),
  );
}

/**
 * A `LINK-` code from the match page's "stay updated" card: this number becomes the web player's, and
 * the answer is their match and their calendar. It is a reply to the message the player just sent, so
 * it needs no template and goes inside the 24-hour window, like every other answer here; since 1
 * October 2026 Meta charges it, as it charges every reply (link.ts says what is known of the price).
 * It runs before the number is looked up, because looking it up creates a player for a new number, and
 * a linked number must not leave a second one behind.
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
 *
 * What the thread reads, and what each does:
 *   - `JOIN-7KQ2` (the hand-off link's own words), `JOIN 7KQ2`: takes the seat at once, so the hand-off
 *     is two taps, the link and Send, and answers with the line-up and three buttons: can't make it,
 *     who is in, add to calendar.
 *   - a pasted match link, or the code alone: the match and its three buttons, I'm in among them; a
 *     link is not a request to join until the player says so.
 *   - a tap: `wj:` in, `wl:` out, `ww:` who is in, `wc:` the calendar, `wv:` a level, then in.
 *   - anything else: the help, which says all of the above.
 *
 * Meta can deliver one message twice, and a JOIN takes a seat, so a message id is answered once
 * (`wa:duplicate` the second time); the guard is a rate row, so it needs no table of its own.
 */
export async function handleWhatsappMessage(db: Db, msg: WaInboundMessage, contact?: WaContact): Promise<string> {
  if (msg.id && !(await takeRate(db, "wamsg", msg.id, 1))) return "wa:duplicate";
  const bind = msg.type === "text" ? bindInText(readInbound(msg).text) : null;
  if (bind) return bindFromPage(db, msg.from, bind);
  // A number writing for the first time becomes a record named by its WhatsApp profile; known for the count below.
  const known = await findWhatsappPlayer(db, msg.from);
  let player = known ?? (await findOrCreateWhatsappPlayer(db, msg.from, contact?.profile?.name));
  const locale = localeOf(player);
  const s = S[locale];
  const { text, tappedId } = readInbound(msg);

  const tap = tappedId ? /^(wj|wl|ww|wc):([A-Za-z0-9]{4})$/.exec(tappedId) : null;
  const band = tappedId ? /^wv:([A-Za-z0-9]{4}):(\d{1,3})$/.exec(tappedId) : null;
  // Never re-cased: the code alphabet is mixed case, so changing it finds a different match or none.
  const joinCode = tap || band ? null : codeInJoinText(text);
  const lookCode = tap || band || joinCode ? null : (codeInMatchUrl(text) ?? (isValidShareCode(text.trim()) ? text.trim() : null));
  const code = tap ? tap[2] : band ? band[1] : (joinCode ?? lookCode);
  if (!code) {
    await sendText(msg.from, s.help);
    return "wa:help";
  }

  const detail = await getEventByCode(db, code);
  if (!detail || detail.event.status === "cancelled") {
    await sendText(msg.from, s.gone);
    return "wa:gone";
  }

  if (lookCode || tap?.[1] === "ww") {
    // A bare code, a pasted link, or "who else is in?" all answer the same way: the match as it stands.
    await showMatch(msg.from, detail, locale);
    return tap ? "wa:lineup" : "wa:match";
  }

  if (tap?.[1] === "wc") {
    // The calendar page, never the personal link: a message can be forwarded, and the page signs nobody
    // in. A player whose address already brings an invitation per match gets this match's own file.
    const link = feedCalendar(player) ? s.calendarFeed(feedLinks(baseUrl(), await feedKeyFor(db, player), locale).page) : s.calendarOne(`${baseUrl()}/${code}/calendar.ics`);
    await sendText(msg.from, link);
    return "wa:calendar";
  }

  const before = wasComplete(detail);

  if (tap?.[1] === "wl") {
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

  // Over: said before anything is asked or saved, so an old JOIN never asks a level for a match that was played.
  if (detail.event.status === "past" || isOver(detail.event, new Date())) {
    await sendText(msg.from, s.past);
    return "wa:past";
  }

  if (band) {
    const level = normalizeLevel(Number(band[2]) / 100);
    if (level == null) {
      await sendText(msg.from, s.help);
      return "wa:help";
    }
    // The player's own number, saved once: a tap on an old button never overwrites a level set since.
    if (player.level == null) {
      await setPlayerLevel(db, player.id, level);
      player = (await getPlayer(db, player.id)) ?? player;
    }
  }

  // A seat the organiser held for this very number (a name and the phone typed on the web): it is theirs.
  const heldForMe = detail.roster.find((x) => x.status === "invited" && x.inviteCode && sameNumber(x.invitedPhone, msg.from));
  if (heldForMe) {
    const res = await confirmInvite(db, { inviteCode: heldForMe.inviteCode!, playerId: player.id }).catch(() => null);
    if (res?.outcome === "confirmed") {
      if (res.event.groupId) await joinGroup(db, res.event.groupId, player.id, "match").catch(() => undefined);
      const now = (await getEventByCode(db, code)) ?? detail;
      await showSeat(msg.from, now, locale, s.joined(`${whenOf(now, locale)}${whereOf(now)}`, spotsLeft(now)));
      await notifyCreator(db, res.event, "confirmed", player.displayName, player.id).catch(() => undefined);
      const ev = await notifyLineupChange(db, res.event, before, player.id).catch(() => null);
      await sendCalendarInvite(db, ev ?? res.event, player).catch(() => undefined);
      return "wa:confirmed";
    }
  }

  // A new number whose profile name is already in the match: counted as the web counts it (`newid_name_here`).
  if (!known) {
    const namesHere = [...detail.roster, ...detail.waitlist].filter((x) => x.status !== "empty" && x.status !== "declined").map((x) => x.player?.displayName ?? x.invitedName);
    if (nameIsHere(player.displayName, namesHere)) await bumpMetric(db, "newid_name_here").catch(() => undefined);
  }

  // JOIN, the "I'm in" tap, and a level just chosen: the seat, through the domain's own rules.
  try {
    const decision = await joinWithPolicy(db, detail, player, player.level);
    if (decision.kind === "level_required") {
      await askLevel(msg.from, detail, locale);
      return "wa:level_required";
    }
    if (decision.kind === "requested") {
      await sendText(msg.from, s.requested);
      // What the reply promises: the organiser hears it, as from the web and the API.
      await notifyCreator(db, detail.event, "requested", player.level != null ? `${player.displayName} (${formatLevel(player.level)})` : player.displayName, player.id).catch(() => undefined);
      return "wa:requested";
    }
    const out = decision.result;
    const now = (await getEventByCode(db, code)) ?? detail;
    if (out.outcome === "already_in") await showSeat(msg.from, now, locale, s.already);
    else if (out.outcome === "full") await sendText(msg.from, s.full);
    else if (out.outcome === "waitlisted") await showSeat(msg.from, now, locale, s.waitlisted(whenOf(now, locale)));
    else await showSeat(msg.from, now, locale, s.joined(`${whenOf(now, locale)}${whereOf(now)}`, spotsLeft(now)));
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
