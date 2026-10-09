import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { IdentitySync } from "@/components/IdentitySync";
import { PwaSetup } from "@/components/PwaSetup";
import { getDb } from "@/db";
import { APP_NAME, APP_TAGLINE, baseUrl } from "@/lib/config";
import { bumpMetric } from "@/lib/domain/metrics";
import { later } from "@/lib/alerts";
import { getSessionPlayer } from "@/lib/session";
import { htmlTextAttr, TEXT_SIZE_COOKIE, textSizeOf } from "@/lib/textSize";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: APP_TAGLINE,
  metadataBase: new URL(baseUrl()),
  applicationName: APP_NAME,
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
  formatDetection: { telephone: false },
  // Yandex Webmaster ownership (the Russian search index matters for Phuket).
  verification: { yandex: "a205f02ae7fc481b" },
};

export const viewport: Viewport = {
  // The browser's own bar matches the page's ground in each theme (--color-bg in globals.css).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f3ee" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1520" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  // "Bigger text" is a cookie, read here so the first paint is already the size the person chose.
  const textSize = htmlTextAttr(textSizeOf((await cookies()).get(TEXT_SIZE_COOKIE)?.value));
  let me: { id: string; name: string } | null = null;
  try {
    const db = await getDb();
    const p = await getSessionPlayer(db);
    if (p) me = { id: p.id, name: p.displayName };
    // Our own page-render counter, so the service board knows when Vercel's analytics ceiling is near. Crawlers do not count.
    const ua = (await headers()).get("user-agent") ?? "";
    if (!/bot|crawl|spider|slurp|facebookexternalhit|preview|uptime|monitor|curl|python-requests|Go-http-client/i.test(ua)) await later(() => bumpMetric(db, "pageviews"));
  } catch (e) {
    console.error("[layout] db unavailable", e);
  }
  return (
    <html lang={locale} data-text={textSize}>
      <body className="min-h-dvh">
        {/* Per-user manifest: start_url is the visitor's personal link, so a home-screen shortcut is always signed in. */}
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <NextIntlClientProvider messages={messages}>
          {children}
          <IdentitySync player={me} />
          <PwaSetup signedIn={Boolean(me)} />
        </NextIntlClientProvider>
        {/* Vercel Web Analytics: page views and Web Vitals, no cookies, no personal data. */}
        <Analytics />
      </body>
    </html>
  );
}
