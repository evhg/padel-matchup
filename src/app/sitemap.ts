import type { MetadataRoute } from "next";
import { baseUrl } from "@/lib/config";
import { getDb } from "@/db";
import { CITIES } from "@/lib/domain/cities";
import { listPublishedAnswers } from "@/lib/listen/answers";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = baseUrl();
  const now = new Date();
  let answerPages: MetadataRoute.Sitemap = [];
  try {
    const db = await getDb();
    answerPages = (await listPublishedAnswers(db, 500)).map((a) => ({ url: `${base}/answers/${a.slug}`, lastModified: a.publishedAt ?? now, changeFrequency: "monthly" as const, priority: 0.6 }));
  } catch {
    answerPages = [];
  }
  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/americano`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    ...[8, 12, 16, 20, 24].map((n) => ({ url: `${base}/americano/${n}`, lastModified: now, changeFrequency: "yearly" as const, priority: 0.6 })),
    { url: `${base}/levels`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/developers`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/agents`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    ...CITIES.map((c) => ({ url: `${base}/${c.slug}`, lastModified: now, changeFrequency: "daily" as const, priority: 0.8 })),
    { url: `${base}/answers`, lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    ...answerPages,
    { url: `${base}/about`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
}
