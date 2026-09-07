import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { bumpMetric, dayKey } from "@/lib/domain/metrics";

/**
 * IndexNow: one POST tells Bing, Yandex, Seznam, Naver and the rest that a page
 * changed. Google is not in the protocol; it reads the sitemap. Enabled by
 * INDEXNOW_KEY (8–128 letters, digits, dashes); the key file is served at
 * /indexnow/<key>.txt. Never throws.
 */
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export function indexNowKey(): string | null {
  const k = (process.env.INDEXNOW_KEY ?? "").trim();
  return /^[A-Za-z0-9-]{8,128}$/.test(k) ? k : null;
}
export const indexNowEnabled = () => indexNowKey() !== null;
export const indexNowKeyPath = (key: string) => `/indexnow/${key}.txt`;

export type IndexNowResult = { status: "skipped" | "sent" | "failed"; urls: number; httpStatus?: number; error?: string };

/** Paths or absolute URLs on our own host; duplicates and foreign hosts dropped. */
export async function pingIndexNow(urls: string[], o: { db?: Db; fetchImpl?: typeof fetch } = {}): Promise<IndexNowResult> {
  const key = indexNowKey();
  const base = baseUrl();
  const host = new URL(base).host;
  const list = [...new Set(urls.map((u) => (u.startsWith("/") ? `${base}${u}` : u)))]
    .filter((u) => {
      try {
        return new URL(u).host === host;
      } catch {
        return false;
      }
    })
    .slice(0, 10000);
  if (!key || list.length === 0 || /^(localhost|127\.0\.0\.1)(:|$)/.test(host)) return { status: "skipped", urls: list.length };
  try {
    const res = await (o.fetchImpl ?? fetch)(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation: `${base}${indexNowKeyPath(key)}`, urlList: list }),
      signal: AbortSignal.timeout(8000),
    });
    const ok = res.status === 200 || res.status === 202;
    if (ok && o.db) await bumpMetric(o.db, "indexnow_urls", list.length).catch(() => undefined);
    return { status: ok ? "sent" : "failed", urls: list.length, httpStatus: res.status };
  } catch (e) {
    return { status: "failed", urls: list.length, error: String(e) };
  }
}

/**
 * Once a day after 04:00 UTC: the pages that change daily (cities, clubs) plus
 * anything with a real timestamp from the last 36 hours (new answers, edited clubs).
 */
export async function submitIndexNowDaily(db: Db, now = new Date(), fetchImpl?: typeof fetch): Promise<IndexNowResult> {
  if (!indexNowEnabled() || now.getUTCHours() < 4) return { status: "skipped", urls: 0 };
  const day = dayKey(now);
  const [done] = await db.select({ value: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.day, day), eq(metricsDaily.key, "indexnow_daily"))).limit(1);
  if (done && Number(done.value) > 0) return { status: "skipped", urls: 0 };
  await bumpMetric(db, "indexnow_daily", 1, day);
  const { buildSitemap } = await import("@/lib/sitemap");
  const entries = await buildSitemap(db, now);
  const fresh = now.getTime() - 36 * 3600 * 1000;
  const urls = entries
    .filter((e) => {
      if (e.changeFrequency === "daily") return true;
      const t = e.lastModified ? new Date(e.lastModified).getTime() : 0;
      return t !== now.getTime() && t > fresh;
    })
    .map((e) => e.url);
  return pingIndexNow(urls, { db, fetchImpl });
}
