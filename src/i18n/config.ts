export const locales = ["en", "ru", "es"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";

export function toLocale(v: string | null | undefined): Locale | null {
  if (!v) return null;
  const base = v.toLowerCase().split(/[-_]/)[0];
  return (locales as readonly string[]).includes(base) ? (base as Locale) : null;
}

/** Pick the best locale from an Accept-Language header. */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return defaultLocale;
  const ranked = acceptLanguage
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      return { tag, q: q ? Number(q.split("=")[1]) : 1, i };
    })
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const r of ranked) {
    const l = toLocale(r.tag);
    if (l) return l;
  }
  return defaultLocale;
}

export async function loadMessages(locale: Locale) {
  return (await import(`../../messages/${locale}.json`)).default;
}
