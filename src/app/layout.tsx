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
import { countAfter } from "@/lib/countLater";
import { isDeletedPlayer } from "@/lib/domain/result";
import { isCrawler } from "@/lib/source";
import { getSessionPlayer, getSessionPlayerId, restoreSealForSession, sessionRenewDue } from "@/lib/session";
import { pickMessages, ROOT_CLIENT_MESSAGES } from "@/i18n/clientMessages";
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
  // What the browser keeps to come back after a lost cookie: the server's seal, never the player id (IdentitySync).
  let seal: string | null = null;
  // What only a route may act on (IdentitySync asks it): a full sign-in due its new year, or a signed
  // cookie whose record is gone. Cookie reads only; the record is the one read this render makes anyway.
  // A deleted account keeps its row ("Deleted player"), so a browser still signed in to it somewhere else
  // gets no seal and no new year: the route ends that session as one whose record is gone.
  let check: "renew" | "dead" | null = null;
  try {
    const db = await getDb();
    const p = await getSessionPlayer(db);
    if (p && !isDeletedPlayer(p)) {
      seal = await restoreSealForSession(p.id);
      check = (await sessionRenewDue()) ? "renew" : null;
    } else if (p || (await getSessionPlayerId())) check = "dead";
    // Our own page-render counter, so the service board knows when Vercel's analytics ceiling is near. Crawlers do not count.
    // Written with the page's own counters in one statement after the answer (`countAfter`).
    const ua = (await headers()).get("user-agent") ?? "";
    if (!isCrawler(ua)) await countAfter(db, ["pageviews"]);
  } catch (e) {
    console.error("[layout] db unavailable", e);
  }
  return (
    <html lang={locale} data-text={textSize}>
      <body className="min-h-dvh">
        {/* Per-user manifest: start_url is the visitor's personal link, so a home-screen shortcut is always signed in. */}
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        {/* The browser gets no messages here: a page whose client components translate gives its own
            (withClientMessages). The whole catalogue was 146 KB to 230 KB inline in every page. */}
        <NextIntlClientProvider messages={pickMessages(messages, ROOT_CLIENT_MESSAGES)}>
          {children}
          <IdentitySync seal={seal} check={check} />
          <PwaSetup signedIn={Boolean(seal)} />
        </NextIntlClientProvider>
        {/* Vercel Web Analytics: page views and Web Vitals, no cookies, no personal data. */}
        <Analytics />
      </body>
    </html>
  );
}
