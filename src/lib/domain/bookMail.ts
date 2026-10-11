import { detectPlatform } from "@/lib/booking/platforms";
import { formatEventDay } from "@/lib/dates";
import { PASTE_LINKS_MAX, PASTE_TEXT_MAX, type BookingRead } from "./bookingPaste";

/**
 * book@<apex>, the rules (the owner, 11 October 2026: "A new address answers by itself with the filled
 * form link, and with nothing else. It never makes a match from the sender's address, because a
 * sender's address can be faked. It keeps no email body."). A person forwards a booking confirmation,
 * or writes the booking in a mail; the answer is what was read and the filled form's link.
 *
 * Pure: the headers, the words and the answer. The reads, the limits and the send are in
 * `src/lib/booking/bookMail.ts`. A mail is a stranger's text, so each repeat here is bounded and the
 * raw text is cut before any pattern sees it.
 */

/** What a mail may carry before any pattern reads it: a long forward chain, cut. */
const RAW_TEXT_MAX = 20_000;
const RAW_HTML_MAX = 200_000;
const LINE_MAX = 1_000;

/**
 * A robot wrote it, by its headers (keys in lower case): Auto-Submitted other than "no" (RFC 3834),
 * Precedence bulk, junk or list, a List-Id, the X-Autoreply family, or a delivery report (a bounce).
 */
export function machineMail(headers: Readonly<Record<string, string | undefined>>): boolean {
  const auto = (headers["auto-submitted"] ?? "").trim().toLowerCase();
  if (auto && auto !== "no") return true;
  if (/^(bulk|junk|list)$/i.test((headers["precedence"] ?? "").trim())) return true;
  if ((headers["list-id"] ?? "").trim()) return true;
  if ((headers["x-autoreply"] ?? headers["x-autorespond"] ?? "").trim()) return true;
  return /multipart\/report/i.test(headers["content-type"] ?? "");
}

/** The sender's address is ours (the apex or any host under it): never answered, so book@ never answers itself. */
export function ownDomain(address: string, apex: string): boolean {
  const domain = address.trim().toLowerCase().split("@")[1] ?? "";
  const ours = apex.trim().toLowerCase();
  return Boolean(ours) && (domain === ours || domain.endsWith(`.${ours}`));
}

const FORWARD = /^\s*(?:-{2,}\s*(?:forwarded message|original message|пересылаемое сообщение|исходное сообщение|mensaje reenviado|mensaje original)\s*-{2,}|begin forwarded message:|начало пересылаемого сообщения:|inicio del mensaje reenviado:|_{10,})\s*$/i;
const REPLY_HEAD = /(?:\bwrote|\bescribió|пишет|написал|написала|написал\(а\)):\s*$/i;
const HEADER_LINE = /^\s*\*?\s*(?:from|date|sent|to|cc|bcc|reply-to|de|fecha|enviado|para|от|дата|отправлено|кому|копия)\s*:/i;
const SUBJECT_LINE = /^\s*\*?\s*(?:subject|asunto|тема)\s*:\s*\*?\s*/i;
const SIGNATURE = /^\s*--\s*$/;
const SENT_FROM = /^\s*(?:sent from my|get outlook for|enviado desde mi|отправлено с)/i;
const SUBJECT_PREFIX = /^\s*(?:(?:re|fwd?|tr|rv|aw|wg|enc|пересл|ответ|отв)\s*:\s*)+/i;
const HREF = /href\s*=\s*["']?(https:\/\/[^"'\s<>]{1,500})/gi;

/** The named entities a booking mail writes, beside the five every page uses: dashes, signs, and the accented letters of the three languages' neighbours. */
const LETTERS: Readonly<Record<string, string>> = { aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", uuml: "ü", ouml: "ö", auml: "ä", ccedil: "ç", agrave: "à", egrave: "è", ograve: "ò" };
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  middot: "·",
  hellip: "…",
  euro: "€",
  pound: "£",
  deg: "°",
  iexcl: "¡",
  iquest: "¿",
  ordm: "º",
  ordf: "ª",
  ...LETTERS,
  ...Object.fromEntries(Object.entries(LETTERS).map(([k, v]) => [k[0].toUpperCase() + k.slice(1), v.toUpperCase()])),
};

/**
 * One entity, read: a figure in its bounds (a no-break space, a control character, a surrogate or a
 * figure past Unicode reads as a space), a name from `NAMED`, anything else as written. One pass, so
 * "&amp;#160;" stays "&#160;".
 */
const entity = (whole: string, name: string): string => {
  if (name[0] === "#") {
    const n = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    const blank = !(n > 0) || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) || n < 32 || (n >= 127 && n <= 160);
    return blank ? " " : String.fromCodePoint(n);
  }
  return NAMED[name] ?? NAMED[name.toLowerCase()] ?? whole;
};

/**
 * HTML to lines, in one pass that finds each end once (`indexOf`), so a stranger's mail built to stall
 * a pattern cannot (the read of a pasted link paid for that lesson): a line break or the end of a
 * block ends a line, every other tag is a space, a style or a script goes whole, and the entities read
 * (`entity`: figures, dashes, accented letters).
 */
function htmlText(html: string): string {
  const s = html.slice(0, RAW_HTML_MAX);
  const lower = s.toLowerCase();
  let out = "";
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    const gt = s.indexOf(">", lt);
    if (gt < 0) break;
    const name = lower.slice(lt + 1, Math.min(gt, lt + 10));
    const block = /^(style|script)\b/.exec(name)?.[1];
    if (block) {
      const close = lower.indexOf(`</${block}`, gt);
      const end = close < 0 ? -1 : s.indexOf(">", close);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    out += /^(?:br\b|\/(?:p|div|li|tr|h\d)\b)/.test(name) ? "\n" : " ";
    i = gt + 1;
  }
  return out.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, entity);
}

/**
 * The words of a mail, as a paste: the subject without its "Fwd:" and "Re:", then the body without
 * what a cheap rule can tell is not the booking. A reply's quoted part goes (lines that start with
 * ">", and everything from "On … wrote:"), a signature goes (from a "-- " line), "Sent from my
 * phone" goes, and a forward's own header lines go (its From, Date, To: the date a mail was sent is
 * not the day of the booking), while the forwarded message itself stays, because a forwarded
 * confirmation is the whole point. A forward's header block ends at its first blank line after a
 * header line, so a confirmation that starts "Date: Monday 12 October" keeps that line. Bounded to a
 * paste (`PASTE_TEXT_MAX`). The links are the platforms' links behind the HTML's buttons, which a
 * plain-text twin often drops; the words' own links are read from the words, as a paste's are.
 *
 * `own` is what the sender wrote: the body before the first forward marker, and the subject when it
 * is not a forward's or a reply's ("Fwd:", "Re:"). The answer's language comes from it, so a forwarded
 * confirmation from "Club de Pádel Las Rozas" does not turn an English sender's answer into Spanish.
 */
export function mailText(subject: string | null | undefined, text: string | null | undefined, html: string | null | undefined): { text: string; links: string[]; own: string } {
  const body = (text ?? "").trim() ? (text ?? "").slice(0, RAW_TEXT_MAX) : htmlText(html ?? "").slice(0, RAW_TEXT_MAX);
  const out: string[] = [];
  let forwarded = false;
  let inHeader = false;
  let sawHeader = false;
  let inSignature = false;
  /** How many lines the sender wrote before the first forward marker; all of them when there is none. */
  let ownLines = -1;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.slice(0, LINE_MAX);
    if (FORWARD.test(line)) {
      if (!forwarded) ownLines = out.length;
      forwarded = true;
      inHeader = true;
      sawHeader = false;
      inSignature = false;
      continue;
    }
    if (inHeader) {
      if (HEADER_LINE.test(line)) {
        sawHeader = true;
        continue;
      }
      if (SUBJECT_LINE.test(line)) {
        sawHeader = true;
        out.push(line.replace(SUBJECT_LINE, ""));
        continue;
      }
      // A blank line before the first header line (Apple Mail's) is skipped; one after it ends the block.
      if (!line.trim() && !sawHeader) continue;
      inHeader = false;
    }
    if (!forwarded && REPLY_HEAD.test(line)) break;
    if (SIGNATURE.test(line)) {
      inSignature = true;
      continue;
    }
    if (inSignature || SENT_FROM.test(line)) continue;
    if (/^\s*>/.test(line)) {
      // A reply's quote goes; a forward some clients quote keeps its words.
      if (forwarded) out.push(line.replace(/^(?:\s*>)+\s?/, ""));
      continue;
    }
    out.push(line);
  }
  const subjectWords = (subject ?? "").replace(SUBJECT_PREFIX, "").slice(0, 300).trim();
  const lines = (from: string[]) => from.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const words = [subjectWords, lines(out)].filter(Boolean).join("\n");
  const own = [SUBJECT_PREFIX.test(subject ?? "") ? "" : subjectWords, lines(ownLines < 0 ? out : out.slice(0, ownLines))].filter(Boolean).join("\n");
  const links: string[] = [];
  for (const m of (html ?? "").slice(0, RAW_HTML_MAX).matchAll(HREF)) {
    const url = m[1].replace(/&amp;/gi, "&");
    if (detectPlatform(url) && !links.includes(url)) links.push(url);
    if (links.length >= PASTE_LINKS_MAX) break;
  }
  return { text: words.slice(0, PASTE_TEXT_MAX), links, own: own.slice(0, PASTE_TEXT_MAX) };
}

/**
 * The mail quotes book@'s own answer: its words carry the filled form's address (`formPrefix`,
 * `<base>/?src=paste`), as written or encoded (a link a mail client rewrote). A reply that quotes the
 * answer would read as a booking again, and a robot that quotes would loop, so book@ never answers it.
 */
export function quotesOurAnswer(raw: { text?: string | null; html?: string | null }, formPrefix: string): boolean {
  const body = `${(raw.text ?? "").slice(0, RAW_TEXT_MAX)}\n${(raw.html ?? "").slice(0, RAW_HTML_MAX)}`.toLowerCase();
  const prefix = formPrefix.toLowerCase();
  return body.includes(prefix) || body.includes(encodeURIComponent(formPrefix).toLowerCase());
}

/** A mail that may hold a booking, before any read: a platform's link, or a day and a time in its words. */
export const mailShowsBooking = (shape: Pick<BookingRead, "platform" | "date" | "time">): boolean => Boolean(shape.platform) || Boolean(shape.date && shape.time);

/** What book@ answers: a booking it read whole enough to fill the form (a platform's link, or the club, the day and the time). */
export const mailBookingRead = (read: Pick<BookingRead, "platform" | "club" | "date" | "time">): boolean => Boolean(read.platform) || Boolean(read.club && read.date && read.time);

type T = (key: string, values?: Record<string, string | number>) => string;

const plusMinutes = (time: string, minutes: number): string => {
  const [h, m] = time.split(":").map(Number);
  const t = (h * 60 + m + minutes) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * The answer's text, and nothing else: what was read in fixed shapes (the club, from the clubs table;
 * the day; the time; the length), the ones the booking did not give named in one line, and the filled
 * form's absolute link. The free-text fields (the court, the price, the players) go in the form's link
 * only, never in the words of the mail: a sender's address can be faked, so the words of an answer must
 * carry nothing that the sender chose ("Players: Visit claimprize.example" to a stranger). A booking
 * read from its link alone says so in its first line. No sign-in link, no personal link, no match: the
 * form makes the match when the person taps its button. `t` is the translator for the mail's language. Pure.
 */
export function bookAnswer(read: BookingRead, formUrl: string, t: T, locale: string): string {
  const day = read.date ? formatEventDay(new Date(`${read.date}T12:00:00Z`), "UTC", locale) : null;
  const time = read.time ? (read.minutes ? `${read.time}–${plusMinutes(read.time, read.minutes)}` : read.time) : null;
  const fields: [string, string | null][] = [
    [t("email.bookClub"), read.club?.name ?? null],
    [t("email.bookDay"), day],
    [t("email.bookTime"), time],
    [t("email.bookLength"), read.minutes ? t("email.bookMinutes", { minutes: read.minutes }) : null],
  ];
  const got = fields.filter(([, v]) => v).map(([label, v]) => `${label}: ${v}`);
  const missing = fields.filter(([, v]) => !v).map(([label]) => label.toLocaleLowerCase(locale));
  return [
    ...(got.length ? [t("email.bookIntro"), "", ...got, ...(missing.length ? ["", t("email.bookMissing", { fields: missing.join(", ") })] : [])] : [t("email.bookIntroLink")]),
    "",
    t("email.bookOpen"),
    formUrl,
    "",
    t("email.bookFooter"),
  ].join("\n");
}
