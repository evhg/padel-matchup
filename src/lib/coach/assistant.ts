import { utcToZonedParts, zonedTimeToUtc } from "@/lib/dates";
import { handleFromName, type HoursPreset } from "@/lib/domain/coaching";

/**
 * The courtside assistant's ear: one line typed on a phone becomes an intent.
 * Deterministic on purpose: a coach's "anna fri 15" must mean the same thing every
 * time. English, Russian and Spanish words; free order; no model in the loop.
 */

export type StudentRef = { id: string; name: string };
export type Match = { kind: "one"; student: StudentRef } | { kind: "many"; candidates: StudentRef[] } | { kind: "new"; name: string } | { kind: "none" };

export type CoachIntent =
  | { kind: "book"; student: Match; startsAt: Date; day: string; time: string }
  | { kind: "cancel"; student: Match | null; day: string | null; time: string | null }
  | { kind: "move"; student: Match | null; day: string | null; time: string | null; startsAt: Date | null }
  | { kind: "owed"; student: Match | null }
  | { kind: "block"; from: Date; to: Date; day: string }
  | { kind: "package"; student: Match; size: number; validDays: number | null; amount: number | null; expiresAt: Date | null }
  | { kind: "agenda"; day: string | "week" }
  | { kind: "low" }
  | { kind: "help" };

export type StudentIntent =
  | { kind: "book"; day: string; time: string | null; startsAt: Date | null }
  | { kind: "cancel"; day: string | null; time: string | null }
  | { kind: "move"; day: string | null; time: string | null; startsAt: Date | null }
  | { kind: "paid" }
  | { kind: "left" }
  | { kind: "lessons" }
  | { kind: "help" };

const DAY_MS = 86_400_000;

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
  вс: 0, воскресенье: 0, пн: 1, понедельник: 1, вт: 2, вторник: 2, ср: 3, среда: 3, среду: 3, чт: 4, четверг: 4, пт: 5, пятница: 5, пятницу: 5, сб: 6, суббота: 6, субботу: 6,
  dom: 0, domingo: 0, lun: 1, lunes: 1, mar: 2, martes: 2, mié: 3, mie: 3, miércoles: 3, miercoles: 3, jue: 4, jueves: 4, vie: 5, viernes: 5, sáb: 6, sab: 6, sábado: 6, sabado: 6,
};
const TODAY = new Set(["today", "сегодня", "hoy"]);
const TOMORROW = new Set(["tomorrow", "tmr", "tmrw", "завтра", "mañana", "manana"]);
const WEEK = new Set(["week", "неделя", "неделю", "semana"]);
const CANCEL = new Set(["cancel", "cancelled", "отмена", "отменить", "отмени", "cancelar", "cancela", "anular"]);
const BLOCK = new Set(["block", "off", "blocked", "busy", "блок", "занят", "занята", "выходной", "bloquear", "bloquea", "libre", "ocupado"]);
const LOW = new Set(["low", "мало", "bajo", "bajos"]);
// "move" has to beat "book": "move anna fri 15" carries a name and a time, which is a booking line
// in every other respect. The flag is read before the booking branch for exactly that reason.
const MOVE = new Set(["move", "moved", "reschedule", "перенеси", "перенести", "перенос", "перенесите", "mover", "mueve", "cambiar", "cambia"]);
const PAID = new Set(["paid", "оплатил", "оплатила", "оплачено", "pagado", "pagada", "pague", "pagué"]);
const OWED = new Set(["owes", "owed", "unpaid", "долг", "долги", "должен", "должна", "deuda", "deudas", "debe"]);
const LEFT = new Set(["left", "balance", "осталось", "остаток", "quedan", "saldo"]);
const LESSONS = new Set(["lessons", "занятия", "clases", "agenda"]);
const HELP = new Set(["help", "помощь", "ayuda", "?"]);
const BOOK = new Set(["book", "запиши", "записать", "запись", "reservar", "reserva", "lesson", "занятие", "clase", "with", "с", "con", "at", "в", "a", "the", "on", "for", "для", "para", "el", "la", "las", "los"]);
const UNTIL = new Set(["until", "till", "to", "до", "hasta"]);

const TIME_RE = /^(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?$/i;
const DATE_RE = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/;

export const normalizeName = (s: string) => handleFromName(s).replace(/-/g, " ");

/** Finds a student by what the coach typed: exact, then prefix, then contains, on transliterated lowercase. */
export function matchStudent(typed: string, students: StudentRef[]): Match {
  const q = normalizeName(typed).trim();
  if (!q || q === "coach") return { kind: "none" };
  const norm = students.map((s) => ({ s, n: normalizeName(s.name).trim() }));
  const exact = norm.filter((x) => x.n === q);
  if (exact.length === 1) return { kind: "one", student: exact[0].s };
  if (exact.length > 1) return { kind: "many", candidates: exact.map((x) => x.s) };
  const firstWord = q.split(" ")[0];
  const prefix = norm.filter((x) => x.n.startsWith(q) || x.n.split(" ")[0] === firstWord);
  if (prefix.length === 1) return { kind: "one", student: prefix[0].s };
  if (prefix.length > 1) return { kind: "many", candidates: prefix.map((x) => x.s) };
  const contains = norm.filter((x) => x.n.includes(q));
  if (contains.length === 1) return { kind: "one", student: contains[0].s };
  if (contains.length > 1) return { kind: "many", candidates: contains.map((x) => x.s) };
  return { kind: "new", name: typed.trim().replace(/\s+/g, " ").slice(0, 40) };
}

type Parts = { day: string | null; dayExplicit: boolean; time: string | null; words: string[]; plus: number | null; days: number | null; amount: number | null; until: string | null; range: [string, string] | null; flags: Set<string> };

function parseTime(tok: string): string | null {
  const m = TIME_RE.exec(tok);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  // A bare small number is an hour; anything under 6 without am/pm is more likely afternoon for a coach.
  if (!m[2] && !ap && h >= 1 && h <= 6) h += 12;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function resolveDay(token: string, todayStr: string): string | null {
  const t = token.toLowerCase();
  const base = new Date(`${todayStr}T00:00:00Z`);
  if (TODAY.has(t)) return todayStr;
  if (TOMORROW.has(t)) return new Date(base.getTime() + DAY_MS).toISOString().slice(0, 10);
  if (t in WEEKDAYS) {
    const delta = (WEEKDAYS[t] - base.getUTCDay() + 7) % 7;
    return new Date(base.getTime() + delta * DAY_MS).toISOString().slice(0, 10);
  }
  const d = DATE_RE.exec(t);
  if (d) {
    const day = Number(d[1]);
    const month = Number(d[2]);
    let year = d[3] ? Number(d[3]) : base.getUTCFullYear();
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    let date = new Date(Date.UTC(year, month - 1, day));
    if (!d[3] && date.getTime() < base.getTime() - 60 * DAY_MS) date = new Date(Date.UTC(year + 1, month - 1, day));
    return date.toISOString().slice(0, 10);
  }
  return null;
}

/** Splits a line into the pieces every intent is made of. */
export function tokenize(text: string, todayStr: string): Parts {
  const parts: Parts = { day: null, dayExplicit: false, time: null, words: [], plus: null, days: null, amount: null, until: null, range: null, flags: new Set() };
  const tokens = text
    .replace(/[,;!]+/g, " ")
    .replace(/(\d)\s*(am|pm)\b/gi, "$1$2")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i].length > 1 ? tokens[i].replace(/[?.!…]+$/u, "") : tokens[i];
    const tok = raw.toLowerCase().replace(/^@/, "");
    if (!tok) continue;
    const rangeM = /^(\d{1,2}(?:[:.]\d{2})?)\s*[-–]\s*(\d{1,2}(?:[:.]\d{2})?)$/.exec(tok);
    if (rangeM) {
      const a = parseTime(rangeM[1]);
      const b = parseTime(rangeM[2]);
      if (a && b) parts.range = [a, b];
      continue;
    }
    if (/^\+\d{1,3}$/.test(tok)) {
      parts.plus = Number(tok.slice(1));
      continue;
    }
    if (/^\d{1,3}(d|дн|д|días|dias)$/.test(tok)) {
      parts.days = Number(tok.replace(/\D+$/, ""));
      continue;
    }
    if (UNTIL.has(tok) && tokens[i + 1]) {
      const d = resolveDay(tokens[i + 1].toLowerCase(), todayStr);
      if (d) {
        parts.until = d;
        i++;
        continue;
      }
    }
    const day = resolveDay(tok, todayStr);
    if (day) {
      parts.day = day;
      parts.dayExplicit = true;
      continue;
    }
    if (/^\d{3,6}(฿|thb|บาท|бат|б|€|\$)?$/i.test(tok) && !TIME_RE.test(tok)) {
      parts.amount = Number(tok.replace(/\D/g, ""));
      continue;
    }
    if (/^\d{4}$/.test(tok) && Number(tok) >= 1000) {
      parts.amount = Number(tok);
      continue;
    }
    const time = parseTime(tok);
    if (time && !/^\d{3,}$/.test(tok)) {
      parts.time = time;
      continue;
    }
    if (MOVE.has(tok)) parts.flags.add("move");
    else if (PAID.has(tok)) parts.flags.add("paid");
    else if (OWED.has(tok)) parts.flags.add("owed");
    else if (CANCEL.has(tok)) parts.flags.add("cancel");
    else if (BLOCK.has(tok)) parts.flags.add("block");
    else if (LOW.has(tok)) parts.flags.add("low");
    else if (LEFT.has(tok)) parts.flags.add("left");
    else if (LESSONS.has(tok)) parts.flags.add("lessons");
    else if (WEEK.has(tok)) parts.flags.add("week");
    else if (HELP.has(tok)) parts.flags.add("help");
    else if (BOOK.has(tok)) parts.flags.add("book");
    else if (/^\p{L}[\p{L}'’-]*$/u.test(raw.replace(/^@/, ""))) parts.words.push(raw.replace(/^@/, ""));
  }
  // "to" means an expiry date only in a package line, which always carries "+N". Everywhere else it
  // is ordinary English — "move to fri 15" — and swallowing the day there moved the lesson to today.
  if (parts.day === null && parts.until !== null && parts.plus === null) {
    parts.day = parts.until;
    parts.dayExplicit = true;
    parts.until = null;
  }
  return parts;
}

export type ParseContext = { now: Date; tz: string; students: StudentRef[] };

/** The coach's line → an intent. Anything unclear is "help", never a guess that books the wrong person. */
export function parseCoachLine(text: string, ctx: ParseContext): CoachIntent {
  const todayStr = utcToZonedParts(ctx.now, ctx.tz).date;
  const p = tokenize(text, todayStr);
  const nameTyped = p.words.join(" ");
  const student = nameTyped ? matchStudent(nameTyped, ctx.students) : null;

  if (p.flags.has("help")) return { kind: "help" };
  if (p.flags.has("low")) return { kind: "low" };
  if (p.flags.has("week") && !nameTyped) return { kind: "agenda", day: "week" };
  if (p.plus !== null && student) {
    return { kind: "package", student, size: p.plus, validDays: p.days, amount: p.amount, expiresAt: p.until ? new Date(`${p.until}T23:59:00Z`) : null };
  }
  if (p.flags.has("block")) {
    const day = p.day ?? todayStr;
    if (p.range) return { kind: "block", from: zonedTimeToUtc(day, p.range[0], ctx.tz), to: zonedTimeToUtc(day, p.range[1], ctx.tz), day };
    if (p.time) return { kind: "block", from: zonedTimeToUtc(day, p.time, ctx.tz), to: new Date(zonedTimeToUtc(day, p.time, ctx.tz).getTime() + 3_600_000), day };
    return { kind: "block", from: zonedTimeToUtc(day, "00:00", ctx.tz), to: zonedTimeToUtc(day, "23:59", ctx.tz), day };
  }
  if (p.flags.has("owed")) return { kind: "owed", student };
  if (p.flags.has("move")) {
    // The time typed is where the lesson is going, not where it is. Which lesson moves is decided
    // by the flow from the student and the day, because a coach who says "move anna to friday"
    // means the lesson anna already has, and there is usually only one.
    if (!p.time) return { kind: "move", student, day: p.day, time: null, startsAt: null };
    const day = p.day ?? todayStr;
    return { kind: "move", student, day, time: p.time, startsAt: zonedTimeToUtc(day, p.time, ctx.tz) };
  }
  if (p.flags.has("cancel")) return { kind: "cancel", student, day: p.day, time: p.time };
  if (p.time && student) {
    let day = p.day ?? todayStr;
    let startsAt = zonedTimeToUtc(day, p.time, ctx.tz);
    if (!p.dayExplicit && startsAt.getTime() <= ctx.now.getTime()) {
      day = new Date(new Date(`${todayStr}T00:00:00Z`).getTime() + DAY_MS).toISOString().slice(0, 10);
      startsAt = zonedTimeToUtc(day, p.time, ctx.tz);
    }
    return { kind: "book", student, startsAt, day, time: p.time };
  }
  if (p.day && !nameTyped && !p.time) return { kind: "agenda", day: p.day };
  if (!nameTyped && !p.day && !p.time && (p.flags.has("lessons") || text.trim() === "")) return { kind: "agenda", day: todayStr };
  return { kind: "help" };
}

/** The student's line → an intent. */
export function parseStudentLine(text: string, ctx: { now: Date; tz: string }): StudentIntent {
  const todayStr = utcToZonedParts(ctx.now, ctx.tz).date;
  const p = tokenize(text, todayStr);
  if (p.flags.has("help")) return { kind: "help" };
  if (p.flags.has("paid")) return { kind: "paid" };
  if (p.flags.has("left")) return { kind: "left" };
  if (p.flags.has("move")) {
    if (!p.time) return { kind: "move", day: p.day, time: null, startsAt: null };
    const day = p.day ?? todayStr;
    return { kind: "move", day, time: p.time, startsAt: zonedTimeToUtc(day, p.time, ctx.tz) };
  }
  if (p.flags.has("cancel")) return { kind: "cancel", day: p.day, time: p.time };
  if (p.flags.has("lessons") && !p.day && !p.time) return { kind: "lessons" };
  if (p.day || p.time) {
    const day = p.day ?? todayStr;
    const startsAt = p.time ? zonedTimeToUtc(day, p.time, ctx.tz) : null;
    return { kind: "book", day, time: p.time, startsAt };
  }
  return { kind: "help" };
}

// ---------------------------------------------------------------------------
// Settings, as lines rather than a screen.
//
// A coach's hours, price, cutoff and clubs were the last things that forced them onto the web, and a
// settings form is the one shape a chat cannot borrow. So each setting is its own line, in the same
// idiom as the rest of the assistant: "price 800", "hours mornings", "cutoff 12".
//
// The keyword has to be the first word. That is what keeps this parser from stealing a booking line:
// a student called Priya and a line "priya 800" are untouched, because "price" is not "priya" and the
// booking parser never sees a line that starts with a setting word.
// ---------------------------------------------------------------------------

export type CoachSetting =
  | { kind: "show" }
  | { kind: "price"; amount: number }
  | { kind: "lesson"; minutes: number }
  | { kind: "hours"; preset: HoursPreset }
  | { kind: "cutoff"; hours: number }
  | { kind: "passes"; count: number }
  | { kind: "club"; name: string }
  | { kind: "promptpay"; id: string };


const SHOW = new Set(["settings", "настройки", "ajustes"]);
const PRICE = new Set(["price", "цена", "precio"]);
const LESSON = new Set(["lesson", "занятие", "clase"]);
const HOURS_W = new Set(["hours", "часы", "horas"]);
const CUTOFF = new Set(["cutoff", "порог", "margen"]);
const PASSES = new Set(["passes", "pass", "пропуски", "пропуск", "pases", "pase"]);
const CLUB = new Set(["club", "клуб"]);
const PROMPTPAY = new Set(["promptpay", "промптпей"]);

const PRESETS: Record<string, HoursPreset> = {
  mornings: "mornings", morning: "mornings", утро: "mornings", утром: "mornings", mañanas: "mornings", mananas: "mornings", mañana: "mornings",
  afternoons: "afternoons", afternoon: "afternoons", вечер: "afternoons", вечером: "afternoons", tardes: "afternoons", tarde: "afternoons",
  both: "both", оба: "both", всё: "both", все: "both", ambos: "both", todo: "both",
};

/** A settings line, or null when this is not one and the booking parser should read it instead. */
export function parseCoachSetting(text: string): CoachSetting | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const head = tokens[0].toLowerCase().replace(/[:.!?]+$/u, "");
  const rest = tokens.slice(1).join(" ").trim();
  const num = () => {
    const n = Number(rest.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  if (SHOW.has(head) && !rest) return { kind: "show" };
  if (PRICE.has(head)) {
    const n = num();
    return n === null ? { kind: "show" } : { kind: "price", amount: Math.round(n) };
  }
  if (LESSON.has(head)) {
    const n = num();
    // Only the four the book offers; anything else is a typo, and a 7-minute lesson helps nobody.
    return n !== null && [45, 60, 90, 120].includes(Math.round(n)) ? { kind: "lesson", minutes: Math.round(n) } : null;
  }
  if (HOURS_W.has(head)) {
    const preset = PRESETS[rest.toLowerCase()];
    return preset ? { kind: "hours", preset } : { kind: "show" };
  }
  if (CUTOFF.has(head)) {
    const n = num();
    return n === null ? { kind: "show" } : { kind: "cutoff", hours: Math.min(72, Math.round(n)) };
  }
  if (PASSES.has(head)) {
    const n = Number(rest.replace(/[^\d]/g, ""));
    return rest !== "" && Number.isFinite(n) ? { kind: "passes", count: Math.min(9, Math.round(n)) } : { kind: "show" };
  }
  if (CLUB.has(head)) return rest ? { kind: "club", name: rest.slice(0, 80) } : { kind: "show" };
  if (PROMPTPAY.has(head)) return rest ? { kind: "promptpay", id: rest.replace(/\s+/g, "").slice(0, 40) } : { kind: "show" };
  return null;
}
