import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import { pasteBooking, pickClubOf } from "@/lib/booking/paste";
import { detectPlatform } from "@/lib/booking/platforms";
import { baseUrl } from "@/lib/config";
import { formatEventDay } from "@/lib/dates";
import { linksIn, readBooking, type BookingRead, type PickClub } from "@/lib/domain/bookingPaste";
import { listClubsForPaste } from "@/lib/domain/clubs";
import { parseMatchLength } from "@/lib/domain/matchLength";
import { bumpMetric } from "@/lib/domain/metrics";
import { sendText } from "./api";

/**
 * "Paste your booking" in the WhatsApp thread (the owner, 11 October 2026: "I can share the booking page
 * link from ie. Padel Society to a tg or whatsapp bot"). A person who booked a court in a platform's app
 * sends the link or the share text to the Kicksmash number, and gets one answer: what was read and the
 * create form filled with it, the same form as the first page's "Booked already? Paste it". The person
 * checks it there and taps Create. The thread makes no match itself: a WhatsApp reply has no button that
 * could carry the start it showed, as the Telegram bot's "Create match" does.
 *
 * Only a message that is a booking: a link of a platform in `PLATFORMS`, or words that give a day, a
 * time and a club that is listed. Anything else goes on to the help, as before. Nothing of it works
 * until the owner's WhatsApp number is set (`whatsappEnabled`), because no message reaches the thread.
 *
 * The zone is the club's. The thread knows no zone of its own, so a booking with no club gives the form
 * no zone, and the form takes the person's own, never UTC.
 *
 * What it costs (AGENTS.md rule 12): a message that is no booking costs no read, because the shape is
 * checked first with no database (`readBooking` over no clubs); one with a day and a time and no
 * platform's link costs one read of the listed clubs. A booking costs what `pasteBooking` costs (one
 * counter, the clubs handed on, at most one read of the platform's switches and one read of the link, at
 * most one read of the person's last venue), one reply and one day counter.
 */

type Locale = "en" | "ru" | "es";

const S = {
  en: {
    with: (names: string) => `with ${names}`,
    court: (court: string) => `court ${court}`,
    and: " and ",
    or: " or ",
    linkOf: (platform: string) => `A booking on ${platform}`,
    lastClub: (name: string) => `${name} (your last club?)`,
    fields: { club: "the club", date: "the day", time: "the time" },
    missing: (fields: string) => `Your booking does not say ${fields}. Fill it in on the form, then tap Create:`,
    checkClub: "I took the club of your last match. Check it on the form, then tap Create:",
    checkDay: "The weekday and the date in your booking do not match. Check the day on the form, then tap Create:",
    ready: "Check it on the form, then tap Create:",
    limit: "You sent thirty bookings today. That is the limit. Try again tomorrow.",
  },
  ru: {
    with: (names: string) => `игроки: ${names}`,
    court: (court: string) => `корт ${court}`,
    and: " и ",
    or: " и ",
    linkOf: (platform: string) => `Бронь в ${platform}`,
    lastClub: (name: string) => `${name} (ваш последний клуб?)`,
    fields: { club: "клуб", date: "день", time: "время" },
    missing: (fields: string) => `В брони не указано: ${fields}. Заполните это в форме и нажмите «Создать»:`,
    checkClub: "Я взял клуб вашего прошлого матча. Проверьте его в форме и нажмите «Создать»:",
    checkDay: "День недели и дата в вашей брони не совпадают. Проверьте день в форме и нажмите «Создать»:",
    ready: "Проверьте всё в форме и нажмите «Создать»:",
    limit: "Сегодня вы прислали тридцать броней. Это предел. Попробуйте завтра.",
  },
  es: {
    with: (names: string) => `con ${names}`,
    court: (court: string) => `pista ${court}`,
    and: " y ",
    or: " ni ",
    linkOf: (platform: string) => `Una reserva en ${platform}`,
    lastClub: (name: string) => `${name} (¿tu último club?)`,
    fields: { club: "el club", date: "el día", time: "la hora" },
    missing: (fields: string) => `Tu reserva no dice ${fields}. Complétalo en el formulario y toca Crear:`,
    checkClub: "Tomé el club de tu último partido. Compruébalo en el formulario y toca Crear:",
    checkDay: "El día de la semana y la fecha de tu reserva no coinciden. Comprueba el día en el formulario y toca Crear:",
    ready: "Compruébalo en el formulario y toca Crear:",
    limit: "Hoy enviaste treinta reservas. Es el límite. Prueba mañana.",
  },
} as const;

const listOf = (items: readonly string[], last: string): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")}${last}${items[items.length - 1]}`);

const plusMinutes = (time: string, minutes: number): string => {
  const [h, m] = time.split(":").map(Number);
  const t = (h * 60 + m + minutes) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * The answer's text: "📋 WAREHAUS.club, Mon, Oct 12, 18:00–19:30, court 3, with Danny and Alberto",
 * then what is missing or what to check, then the filled form's link. The time range is a length the
 * form takes (60, 90 or 120); any other shows the start alone. Plain text, as WhatsApp shows it. Pure.
 */
export function waPasteAnswer(read: BookingRead, formUrl: string, locale: Locale): string {
  const s = S[locale];
  const parts: string[] = [];
  if (read.club) parts.push(read.clubFrom === "history" ? s.lastClub(read.club.name) : read.club.name);
  if (read.date) parts.push(formatEventDay(new Date(`${read.date}T12:00:00Z`), "UTC", locale));
  const len = parseMatchLength(read.minutes);
  if (read.time) parts.push(len ? `${read.time}–${plusMinutes(read.time, len)}` : read.time);
  if (read.court) parts.push(/^\d/.test(read.court) ? s.court(read.court) : read.court);
  if (read.cost) parts.push(read.cost);
  if (read.names.length) parts.push(s.with(listOf(read.names, s.and)));
  const what = parts.length ? parts.join(", ") : s.linkOf(read.platform?.name ?? "");
  const next = read.missing.length
    ? s.missing(listOf(read.missing.map((f) => s.fields[f]), s.or))
    : read.clubFrom === "history"
      ? s.checkClub
      : read.dayClash
        ? s.checkDay
        : s.ready;
  return `📋 ${what}\n${next}\n${formUrl}`;
}

/**
 * A booking sent to the thread: one answer with what was read and the filled form's link. Null when the
 * message is not a booking, so the thread answers it as before.
 */
export async function pasteInWhatsapp(db: Db, to: string, text: string, player: Player, locale: Locale, now = new Date()): Promise<string | null> {
  if (!text.trim()) return null;
  const links = linksIn(text, []);
  let clubs: PickClub[] | undefined;
  if (!links.some((l) => detectPlatform(l))) {
    // The shape with no read: a day and a time, then a listed club (one read of the clubs, handed on).
    const shape = readBooking({ text, links, clubs: [], now, tz: null });
    if (!shape.date || !shape.time) return null;
    clubs = (await listClubsForPaste(db)).map(pickClubOf);
    if (!readBooking({ text, links, clubs, now, tz: null }).club) return null;
  }
  const got = await pasteBooking(db, { text, tz: null, rateKey: `wa:${player.id}`, playerId: player.id, selfName: player.displayName, now, clubs });
  if (!got.ok) {
    if (got.reason !== "limit") return null;
    await sendText(to, S[locale].limit);
    return "wa:paste_limit";
  }
  await sendText(to, waPasteAnswer(got.read, `${baseUrl()}${got.href}`, locale));
  await bumpMetric(db, "wa_paste_read").catch(() => undefined);
  return got.read.missing.length ? `wa:paste_missing:${got.read.missing.join(",")}` : "wa:paste_read";
}
