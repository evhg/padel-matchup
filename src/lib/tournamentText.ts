import { checkScore, isScoringCode } from "@/lib/domain/draw";

/** The days of a competition, from its local dates ("YYYY-MM-DD"): "10–11 Oct 2026", or one day. Pure. */
export function dayRange(startsOn: string, endsOn: string, locale: string): string {
  const at = (d: string) => new Date(`${d}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  const a = at(startsOn);
  const b = at(endsOn);
  if (startsOn === endsOn) return fmt.format(a);
  // formatRange puts the month where the language puts it ("Oct 19–20, 2026", "19–20 окт. 2026 г.").
  return fmt.formatRange(a, b);
}

/** The level band of a category as a chip: "4.0+", "0.5–2.5", "up to 3.0"; null when there is none. */
export function bandLabel(min: number | null, max: number | null): string | null {
  const f = (n: number) => n.toFixed(1);
  if (min !== null && max !== null) return `${f(min)}–${f(max)}`;
  if (min !== null) return `${f(min)}+`;
  if (max !== null) return `≤ ${f(max)}`;
  return null;
}

/** "Sat 10:20" in the competition's zone and the reader's language. */
export function whenLabel(at: Date, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

/** "Saturday 10 October" for the order of play's day headings. */
export function dayHeading(at: Date, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(at);
}

/** "6-4 3-6 10-8" as sets of two numbers, A then B; null when it is not that shape. Pure. */
export function parseSetsText(text: string): { a: number[]; b: number[] } | null {
  const sets = text
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((x) => x.split(/[-:]/).map(Number));
  if (sets.length === 0 || sets.some((x) => x.length !== 2 || x.some((n) => !Number.isInteger(n) || n < 0))) return null;
  return { a: sets.map((x) => x[0]), b: sets.map((x) => x[1]) };
}

/**
 * Who a typed score gives the match to, before it is saved: the pair named first takes the first
 * number of each set. The rehearsal of 24 September 2026 found the gap: a player listed second typed
 * his own games first ("6-3", he won) and the page gave the match to the other pair, which then moved
 * on in the draw. The form reads the winner back by name. Null until the text is a whole score under
 * the rule. Pure.
 */
export function scoreVerdict(rule: string, text: string): "A" | "B" | null {
  const sets = isScoringCode(rule) ? parseSetsText(text) : null;
  if (!sets || !isScoringCode(rule)) return null;
  const r = checkScore(rule, sets.a, sets.b);
  return r.ok ? r.winner : null;
}
