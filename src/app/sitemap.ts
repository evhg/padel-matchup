import type { MetadataRoute } from "next";
import { baseUrl } from "@/lib/config";
import { getDb } from "@/db";
import { CITIES } from "@/lib/domain/cities";
import { listPublishedAnswers } from "@/lib/listen/answers";
import { listLiveClubs } from "@/lib/domain/clubs";
import { locales } from "@/i18n/config";
import { localePath } from "@/lib/seo";

// Rendered on request: answer pages and club pages appear as soon as they exist (a build-time sitemap would freeze them).
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = baseUrl();
  const now = new Date();
  let answerPages: MetadataRoute.Sitemap = [];
  let clubPages: MetadataRoute.Sitemap = [];
  try {
    const db = await getDb();
    answerPages = (await listPublishedAnswers(db, 500)).map((a) => ({ url: `${base}/answers/${a.slug}`, lastModified: a.publishedAt ?? now, changeFrequency: "monthly" as const, priority: 0.6 }));
    clubPages = (await listLiveClubs(db)).map((c) => ({ url: `${base}/v/${c.slug}`, lastModified: c.updatedAt, changeFrequency: "daily" as const, priority: 0.7 }));
  } catch {
    answerPages = [];
  }
  // Pages that exist in every language: one entry per language, each naming the others (hreflang).
  const inEveryLanguage = (path: string, changeFrequency: "daily" | "weekly" | "monthly" | "yearly", priority: number): MetadataRoute.Sitemap => {
    const languages = Object.fromEntries([...locales.map((l) => [l, `${base}${localePath(path, l)}`]), ["x-default", `${base}${localePath(path, "en")}`]]);
    return locales.map((l) => ({ url: `${base}${localePath(path, l)}`, lastModified: now, changeFrequency, priority: l === "en" ? priority : Math.max(0.1, priority - 0.1), alternates: { languages } }));
  };
  return [
    ...inEveryLanguage("/", "weekly", 1),
    ...inEveryLanguage("/americano", "monthly", 0.8),
    ...[8, 12, 16, 20, 24].flatMap((n) => inEveryLanguage(`/americano/${n}`, "yearly", 0.6)),
    ...inEveryLanguage("/levels", "monthly", 0.7),
    { url: `${base}/developers`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/agents`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    ...CITIES.flatMap((c) => inEveryLanguage(`/${c.slug}`, "daily", 0.8)),
    ...inEveryLanguage("/clubs", "weekly", 0.7),
    ...clubPages,
    { url: `${base}/answers`, lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    ...answerPages,
    ...inEveryLanguage("/about", "yearly", 0.3),
  ];
}
