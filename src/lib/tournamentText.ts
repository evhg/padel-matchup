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
