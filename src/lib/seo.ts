import type { Metadata } from "next";
import { defaultLocale, locales, type Locale } from "@/i18n/config";

/** The URL of a page in a language: plain for English, prefixed for the others. */
export const localePath = (path: string, locale: string): string => (locale === defaultLocale ? path : `/${locale}${path === "/" ? "" : path}` || "/");

/**
 * Canonical and hreflang for a page that exists in every language: the canonical is the
 * variant being served, the alternates name all three plus x-default (English).
 */
export function localeAlternates(path: string, locale: string): NonNullable<Metadata["alternates"]> {
  const languages: Record<string, string> = {};
  for (const l of locales) languages[l] = localePath(path, l);
  languages["x-default"] = localePath(path, defaultLocale);
  return { canonical: localePath(path, (locales as readonly string[]).includes(locale) ? (locale as Locale) : defaultLocale), languages };
}
