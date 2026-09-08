import { createSign } from "node:crypto";
import { apexHost } from "@/lib/config";

/**
 * Google Search Console through the service account in GOOGLE_SERVICE_ACCOUNT_JSON:
 * last week's impressions and clicks, split by language path, for the Sunday digest.
 * Google publishes data with a two- to three-day lag, so the window ends three days ago.
 */
type ServiceAccount = { client_email: string; private_key: string };

export function serviceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<ServiceAccount>;
    return j.client_email && j.private_key ? { client_email: j.client_email, private_key: j.private_key } : null;
  } catch {
    return null;
  }
}

export const searchConsoleEnabled = () => serviceAccount() !== null;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** A signed JWT exchanged for a short-lived access token. */
export async function googleAccessToken(scopes: string[], fetchImpl: typeof fetch = fetch, now = new Date()): Promise<string | null> {
  const sa = serviceAccount();
  if (!sa) return null;
  const iat = Math.floor(now.getTime() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope: scopes.join(" "), aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 })}`;
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  } catch {
    return null;
  }
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
  return json?.access_token ?? null;
}

export type SearchWeek = { from: string; to: string; impressions: number; clicks: number; byLocale: { en: number; ru: number; es: number }; topPages: { page: string; impressions: number; clicks: number }[] };

const day = (d: Date) => d.toISOString().slice(0, 10);

export function localeOfPath(url: string): "en" | "ru" | "es" {
  try {
    const path = new URL(url).pathname;
    return path === "/ru" || path.startsWith("/ru/") ? "ru" : path === "/es" || path.startsWith("/es/") ? "es" : "en";
  } catch {
    return "en";
  }
}

/** Seven full days ending three days ago, by page. Null when not configured or Google does not answer. */
export async function searchWeek(fetchImpl: typeof fetch = fetch, now = new Date()): Promise<SearchWeek | null> {
  const token = await googleAccessToken(["https://www.googleapis.com/auth/webmasters.readonly"], fetchImpl, now).catch(() => null);
  if (!token) return null;
  const to = new Date(now.getTime() - 3 * 86400000);
  const from = new Date(to.getTime() - 6 * 86400000);
  const site = encodeURIComponent(`sc-domain:${apexHost()}`);
  try {
    const res = await fetchImpl(`https://searchconsole.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ startDate: day(from), endDate: day(to), dimensions: ["page"], rowLimit: 500 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { rows?: { keys: string[]; clicks: number; impressions: number }[] };
    const out: SearchWeek = { from: day(from), to: day(to), impressions: 0, clicks: 0, byLocale: { en: 0, ru: 0, es: 0 }, topPages: [] };
    for (const r of json.rows ?? []) {
      out.impressions += r.impressions;
      out.clicks += r.clicks;
      out.byLocale[localeOfPath(r.keys[0])] += r.impressions;
      out.topPages.push({ page: r.keys[0], impressions: r.impressions, clicks: r.clicks });
    }
    out.topPages.sort((a, b) => b.impressions - a.impressions);
    out.topPages = out.topPages.slice(0, 5);
    return out;
  } catch {
    return null;
  }
}
